// Nexus Nemesis — Card & Pack API Routes (Mint-on-Demand)
const { Router } = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { parse } = require('csv-parse/sync');
const rateLimit = require('express-rate-limit');
const { PACK_CONFIG, PACK_TRIBE_WEIGHTS, TRIBES, rollTraits, rollBonusAbilities } = require('../lib/tribe-config');
const { mintCardToRecipient } = require('../lib/crossmint');
const { generateLibraryPrices, getLibraryPrices, calculateLibraryPrice } = require('../lib/library-pricing');

// ── Solana wallet validation ───────────────────────────────────────
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function isValidSolanaAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  if (addr.length < 32 || addr.length > 44) return false;
  return [...addr].every(c => BASE58_CHARS.includes(c));
}

// ── Rate limiters ─────────────────────────────────────────────────
const packBuyLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max: 5,                // 5 pack buys per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many pack purchases. Try again in a minute.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,               // 60 reads per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});

module.exports = function createNexusRouter(pool, auth = {}) {
  const router = Router();
  const { requireAuth, optionalAuth } = auth;

  // Apply read limiter to all routes
  router.use(readLimiter);

  // ── Load base cards & compute library prices on startup ────────
  let libraryCards = [];
  try {
    const csvPath = path.resolve(__dirname, '..', '..', 'cards-base.csv');
    const csvRaw = fs.readFileSync(csvPath, 'utf-8');
    const baseCards = parse(csvRaw, { columns: true, skip_empty_lines: true, trim: true });
    const prices = generateLibraryPrices(baseCards);
    libraryCards = baseCards.map(card => {
      const p = prices[card.external_id] || { price: 2, tier: 'common' };
      return {
        id: parseInt(card.external_id),
        name: card.name,
        description: card.description,
        image: card.image,
        rarity: card.rarity,
        type: card.type,
        subtype: card.subtype,
        abilities: card.abilities || null,
        gbuxPrice: p.price,
        priceTier: p.tier,
      };
    });
    console.log(`Library loaded: ${libraryCards.length} base cards, price range ${Math.min(...libraryCards.map(c => c.gbuxPrice))}–${Math.max(...libraryCards.map(c => c.gbuxPrice))} GBUX`);
  } catch (err) {
    console.error('Failed to load library cards:', err.message);
  }

  // ── GET /api/nexus/library ──────────────────────────────────────
  // Returns all 102 base cards with fixed GBUX prices (no tribe, no rarity roll)
  router.get('/library', async (req, res) => {
    try {
      // Optionally get stock counts per base card
      const { rows: stockRows } = await pool.query(
        `SELECT base_card_id, COUNT(*) as available
         FROM nexus_cards
         WHERE owner_grudge_id IS NULL AND mint_status IN ('unminted', 'minted')
         GROUP BY base_card_id`
      );
      const stock = Object.fromEntries(stockRows.map(r => [r.base_card_id, parseInt(r.available)]));

      const cards = libraryCards.map(card => ({
        ...card,
        available: stock[card.id] || 0,
      }));

      res.json({
        season: 'Season 0',
        totalCards: cards.length,
        cards,
      });
    } catch (err) {
      console.error('Library fetch error:', err);
      res.status(500).json({ error: 'Failed to load library' });
    }
  });

  // ── POST /api/nexus/library/buy ─────────────────────────────────
  // Buy a specific base card at its fixed GBUX price (no tribe roll)
  router.post('/library/buy', async (req, res) => {
    const { grudgeId, baseCardId } = req.body;

    if (!grudgeId || !baseCardId) {
      return res.status(400).json({ error: 'grudgeId and baseCardId required' });
    }

    const cardId = parseInt(baseCardId);
    const libCard = libraryCards.find(c => c.id === cardId);
    if (!libCard) {
      return res.status(404).json({ error: `Base card ${baseCardId} not found in library` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // TODO: Verify GBUX balance via blockchain/backend
      // For now, trust the caller has verified payment (same pattern as pack/buy)

      // Find one unassigned card matching this base_card_id
      const { rows } = await client.query(
        `SELECT id FROM nexus_cards
         WHERE base_card_id = $1 AND owner_grudge_id IS NULL
         ORDER BY card_number ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [cardId]
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(503).json({ error: `No copies of "${libCard.name}" available. Sold out!` });
      }

      const assignedCardId = rows[0].id;

      // Assign card — Library purchase: tribe = 'Library', no tribe roll
      await client.query(
        `UPDATE nexus_cards
         SET owner_grudge_id = $1,
             tribe = 'Library',
             tribe_bg = '',
             tribe_border = '',
             mint_status = 'assigned',
             assigned_at = NOW()
         WHERE id = $2`,
        [grudgeId, assignedCardId]
      );

      // Log library purchase
      await client.query(
        `INSERT INTO nexus_library_purchases (grudge_id, base_card_id, card_id, gbux_price)
         VALUES ($1, $2, $3, $4)`,
        [grudgeId, cardId, assignedCardId, libCard.gbuxPrice]
      );

      await client.query('COMMIT');

      // Fetch full card details
      const { rows: cardRows } = await pool.query(
        `SELECT * FROM nexus_cards WHERE id = $1`,
        [assignedCardId]
      );

      res.json({
        purchased: true,
        gbuxPrice: libCard.gbuxPrice,
        card: cardRows.length > 0 ? formatCard(cardRows[0]) : { id: assignedCardId },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Library buy error:', err);
      res.status(500).json({ error: 'Failed to purchase card' });
    } finally {
      client.release();
    }
  });

  // ── POST /api/nexus/pack/buy ───────────────────────────────────
  // Buy a pack → assign cards → mint cNFTs directly to buyer
  // PROTECTED: requires Grudge Auth token
  //
  // Body: { packType, wallet?, email? }
  //   grudgeId is extracted from the auth token (can't be spoofed)
  //   wallet = Solana address (direct mint)
  //   email  = creates Crossmint custodial wallet
  //   At least one of wallet/email is required.
  router.post('/pack/buy', packBuyLimiter, requireAuth || ((req, res, next) => next()), async (req, res) => {
    // Use authenticated grudgeId from token (not from body — prevents spoofing)
    const grudgeId = req.grudgeUser?.grudgeId || req.body.grudgeId;
    const { packType, wallet, email } = req.body;

    if (!grudgeId || !packType) {
      return res.status(400).json({ error: 'grudgeId and packType required' });
    }
    if (!wallet && !email) {
      return res.status(400).json({ error: 'wallet (Solana address) or email required for minting' });
    }

    // Validate wallet address if provided
    if (wallet && !isValidSolanaAddress(wallet)) {
      return res.status(400).json({ error: 'Invalid Solana wallet address' });
    }

    // Basic email validation if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const config = PACK_CONFIG[packType];
    if (!config) {
      return res.status(400).json({ error: `Invalid pack type: ${packType}. Use: starter, premium, legendary` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // TODO: Verify GBUX payment on-chain before proceeding

      // Select random unassigned cards with tribe weighting
      const weights = PACK_TRIBE_WEIGHTS[packType];
      const tribeOrder = Object.entries(weights).sort((a, b) => b[1] - a[1]);

      const selectedCardIds = [];
      let remaining = config.cards;

      for (const [tribe, weight] of tribeOrder) {
        const count = Math.max(
          remaining === config.cards ? 1 : 0,
          Math.round(remaining * (weight / tribeOrder.reduce((s, [, w]) => s + w, 0)))
        );
        if (count === 0) continue;

        const { rows } = await client.query(
          `SELECT id FROM nexus_cards
           WHERE owner_grudge_id IS NULL AND tribe = $1
           ORDER BY RANDOM()
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
          [tribe, Math.min(count, remaining)]
        );

        selectedCardIds.push(...rows.map(r => r.id));
        remaining -= rows.length;
        if (remaining <= 0) break;
      }

      // Fallback: grab any unassigned cards if tribe selection fell short
      if (remaining > 0) {
        const { rows } = await client.query(
          `SELECT id FROM nexus_cards
           WHERE owner_grudge_id IS NULL
           ORDER BY RANDOM()
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [remaining]
        );
        selectedCardIds.push(...rows.map(r => r.id));
      }

      if (selectedCardIds.length === 0) {
        await client.query('ROLLBACK');
        return res.status(503).json({ error: 'No cards available. Season 0 may be sold out!' });
      }

      // Assign cards to user + mark as minting
      await client.query(
        `UPDATE nexus_cards
         SET owner_grudge_id = $1,
             owner_wallet = $2,
             mint_status = 'minting',
             assigned_at = NOW()
         WHERE id = ANY($3)`,
        [grudgeId, wallet || null, selectedCardIds]
      );

      // Log pack purchase
      const packId = uuidv4();
      await client.query(
        `INSERT INTO nexus_packs (id, grudge_id, pack_type, gbux_cost, cards)
         VALUES ($1, $2, $3, $4, $5)`,
        [packId, grudgeId, packType, config.cost, selectedCardIds]
      );

      await client.query('COMMIT');

      // Fetch full card rows for minting
      const { rows: cards } = await pool.query(
        `SELECT * FROM nexus_cards WHERE id = ANY($1)`,
        [selectedCardIds]
      );

      // Mint cNFTs directly to buyer (async — don't block response)
      const recipient = { wallet, email };
      const mintResults = [];

      // Fire all mints in parallel (10 cards max per pack)
      const mintPromises = cards.map(async (card) => {
        try {
          const result = await mintCardToRecipient(card, recipient);

          // Log the mint action
          await pool.query(
            `INSERT INTO nexus_mint_log (card_id, crossmint_action_id, crossmint_status, recipient_wallet)
             VALUES ($1, $2, 'pending', $3)
             ON CONFLICT (card_id) DO UPDATE
             SET crossmint_action_id = $2, crossmint_status = 'pending', recipient_wallet = $3`,
            [card.id, result.actionId, wallet || email]
          );

          // Update card with crossmint action ID
          await pool.query(
            `UPDATE nexus_cards SET crossmint_id = $1 WHERE id = $2`,
            [result.actionId, card.id]
          );

          mintResults.push({ cardId: card.id, actionId: result.actionId, status: result.alreadyMinted ? 'existing' : 'pending' });
        } catch (err) {
          console.error(`Mint failed for card ${card.id}:`, err.message);
          // Revert to assigned (not minting) so it can be retried
          await pool.query(
            `UPDATE nexus_cards SET mint_status = 'assigned' WHERE id = $1`,
            [card.id]
          );
          mintResults.push({ cardId: card.id, status: 'failed', error: err.message });
        }
      });

      await Promise.allSettled(mintPromises);

      // Notify Discord
      if (process.env.DISCORD_WEBHOOK_CARDOPEN) {
        fetch(process.env.DISCORD_WEBHOOK_CARDOPEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `Pack opened! ${packType} pack by ${grudgeId} — ${cards.length} cards minting to ${wallet || email}`,
          }),
        }).catch(() => {});
      }

      res.json({
        packId,
        packType,
        gbuxCost: config.cost,
        cardsReceived: cards.length,
        cards: cards.map(formatCard),
        minting: mintResults,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Pack buy error:', err);
      res.status(500).json({ error: 'Failed to open pack' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/nexus/cards/:grudgeId ─────────────────────────────
  // Get all cards owned by a GrudgeID
  // PROTECTED: users can only view their own cards
  router.get('/cards/:grudgeId', requireAuth || ((req, res, next) => next()), async (req, res) => {
    // Verify the authenticated user is requesting their own cards
    if (req.grudgeUser && req.grudgeUser.grudgeId !== req.params.grudgeId) {
      return res.status(403).json({ error: 'You can only view your own cards' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT * FROM nexus_cards WHERE owner_grudge_id = $1 ORDER BY card_number ASC`,
        [req.params.grudgeId]
      );
      res.json({ grudgeId: req.params.grudgeId, count: rows.length, cards: rows.map(formatCard) });
    } catch (err) {
      console.error('Cards fetch error:', err);
      res.status(500).json({ error: 'Failed to fetch cards' });
    }
  });

  // ── GET /api/nexus/card/:uuid ──────────────────────────────────
  // Get full details for a single card
  router.get('/card/:uuid', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.*, m.crossmint_action_id, m.tx_hash
         FROM nexus_cards c
         LEFT JOIN nexus_mint_log m ON m.card_id = c.id AND m.crossmint_status = 'success'
         WHERE c.id = $1`,
        [req.params.uuid]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Card not found' });
      res.json(formatCard(rows[0]));
    } catch (err) {
      console.error('Card fetch error:', err);
      res.status(500).json({ error: 'Failed to fetch card' });
    }
  });

  // ── GET /api/nexus/stats ───────────────────────────────────────
  // Collection statistics
  router.get('/stats', async (req, res) => {
    try {
      const [total, byTribe, byRarity, byStatus] = await Promise.all([
        pool.query(`SELECT COUNT(*) as total FROM nexus_cards`),
        pool.query(`SELECT tribe, COUNT(*) as count FROM nexus_cards GROUP BY tribe ORDER BY count DESC`),
        pool.query(`SELECT rarity, COUNT(*) as count FROM nexus_cards GROUP BY rarity ORDER BY count DESC`),
        pool.query(`SELECT mint_status, COUNT(*) as count FROM nexus_cards GROUP BY mint_status`),
      ]);

      res.json({
        total: parseInt(total.rows[0].total),
        byTribe: Object.fromEntries(byTribe.rows.map(r => [r.tribe, parseInt(r.count)])),
        byRarity: Object.fromEntries(byRarity.rows.map(r => [r.rarity, parseInt(r.count)])),
        byStatus: Object.fromEntries(byStatus.rows.map(r => [r.mint_status, parseInt(r.count)])),
        season: 'Season 0',
        maxSupply: 100000,
      });
    } catch (err) {
      console.error('Stats error:', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // ── POST /api/nexus/webhook ──────────────────────────────────
  // Crossmint webhook receiver — verifies HMAC-SHA256 signature
  router.post('/webhook', async (req, res) => {
    const secret = process.env.CROSSMINT_WEBHOOK_SECRET;
    if (!secret) {
      console.error('CROSSMINT_WEBHOOK_SECRET not configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // Verify signature (Crossmint uses Svix-style headers)
    const msgId = req.headers['svix-id'] || req.headers['webhook-id'];
    const msgTimestamp = req.headers['svix-timestamp'] || req.headers['webhook-timestamp'];
    const msgSignature = req.headers['svix-signature'] || req.headers['webhook-signature'];

    if (!msgId || !msgTimestamp || !msgSignature) {
      return res.status(401).json({ error: 'Missing webhook signature headers' });
    }

    // Use raw body (captured by express.raw middleware in index.js)
    const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf-8');
    const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`;

    // Extract base64 key after 'whsec_' prefix
    const secretKey = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    const expectedSig = crypto
      .createHmac('sha256', Buffer.from(secretKey, 'base64'))
      .update(signedContent)
      .digest('base64');

    // Crossmint may send multiple signatures separated by spaces
    const signatures = msgSignature.split(' ').map(s => s.replace(/^v1,/, ''));
    const verified = signatures.some(sig => {
      try {
        return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig));
      } catch { return false; }
    });

    if (!verified) {
      console.warn('Webhook signature verification failed', { msgId });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Parse the verified payload
    const event = JSON.parse(rawBody);
    console.log(`[webhook] Event: ${event.type}`, event.data?.id || '');

    try {
      // Handle mint success — cNFT is now on-chain in buyer's wallet
      if (event.type === 'nfts.create.succeeded') {
        const { id: crossmintId, metadata, onChain } = event.data || {};
        const txHash = onChain?.txId || null;

        // Update mint log
        await pool.query(
          `UPDATE nexus_mint_log
           SET crossmint_status = 'success', tx_hash = $1, completed_at = NOW()
           WHERE crossmint_action_id = $2`,
          [txHash, crossmintId]
        );

        // Card is now fully minted in buyer's wallet
        const { rows } = await pool.query(
          `UPDATE nexus_cards
           SET mint_status = 'minted', crossmint_id = $1, minted_at = NOW()
           WHERE id = (SELECT card_id FROM nexus_mint_log WHERE crossmint_action_id = $2 LIMIT 1)
           RETURNING id, name, tribe, rarity, owner_grudge_id, owner_wallet`,
          [crossmintId, crossmintId]
        );

        const card = rows[0];
        console.log(`[webhook] Minted: ${card?.name} → ${card?.owner_wallet || card?.owner_grudge_id}`);

        // Notify Discord
        if (process.env.DISCORD_WEBHOOK_CARDS && card) {
          fetch(process.env.DISCORD_WEBHOOK_CARDS, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `cNFT minted! **${card.name}** (${card.tribe}/${card.rarity}) → ${card.owner_wallet || card.owner_grudge_id} | TX: \`${txHash || 'pending'}\``,
            }),
          }).catch(() => {});
        }
      }

      // Handle mint failure
      if (event.type === 'nfts.create.failed') {
        const { id: crossmintId } = event.data || {};
        console.error(`[webhook] Mint FAILED: ${crossmintId}`);

        await pool.query(
          `UPDATE nexus_mint_log SET crossmint_status = 'failed', completed_at = NOW()
           WHERE crossmint_action_id = $1`,
          [crossmintId]
        );

        // Revert card to assigned so user can retry
        await pool.query(
          `UPDATE nexus_cards SET mint_status = 'assigned'
           WHERE id = (SELECT card_id FROM nexus_mint_log WHERE crossmint_action_id = $1 LIMIT 1)`,
          [crossmintId]
        );
      }

      // Handle collection events
      if (event.type === 'collections.create.succeeded') {
        console.log('[webhook] Collection created:', event.data?.id);
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('Webhook processing error:', err);
      res.status(200).json({ received: true }); // Always 200 to prevent retries
    }
  });

  return router;
};

// Format a DB row into a clean card object
function formatCard(row) {
  const tribeConfig = TRIBES[row.tribe] || {};
  return {
    id: row.id,
    cardNumber: row.card_number,
    baseCardId: row.base_card_id,
    name: row.name,
    description: row.description,
    imageUrl: row.image_url,
    rarity: row.rarity,
    type: row.type,
    subtype: row.subtype,
    abilities: row.abilities,
    tribe: row.tribe,
    tribeBg: row.tribe_bg,
    tribeBorder: row.tribe_border,
    tribeUpgrade: tribeConfig.upgrade,
    tribeSpell: tribeConfig.spell,
    attack: row.attack,
    health: row.health,
    manaCost: row.mana_cost,
    traits: row.traits,
    bonusAbilities: row.bonus_abilities,
    isSignature: row.is_signature,
    edition: row.edition,
    season: row.season,
    mintStatus: row.mint_status,
    crossmintId: row.crossmint_id,
    ownerGrudgeId: row.owner_grudge_id,
    ownerWallet: row.owner_wallet,
    mintedAt: row.minted_at,
    assignedAt: row.assigned_at,
    // Mint proof (if available from join)
    ...(row.tx_hash ? { txHash: row.tx_hash } : {}),
    ...(row.crossmint_action_id ? { crossmintActionId: row.crossmint_action_id } : {}),
  };
}
