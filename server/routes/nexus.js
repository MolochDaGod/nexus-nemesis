// Nexus Nemesis — Card & Pack API Routes (Mint-on-Demand)
const { Router } = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { parse } = require('csv-parse/sync');
const rateLimit = require('express-rate-limit');
const {
  PACK_CONFIG,
  PACK_TRIBE_WEIGHTS,
  TRIBES,
  SEASON1_MAX_SUPPLY,
  SEASON_LIBRARY,
  SEASON_TRIBE,
  LIBRARY_TRIBE,
  rollTribe,
  rollTraits,
  rollBonusAbilities,
} = require('../lib/tribe-config');
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
  /** Raw CSV rows for Season 1 mint-on-demand pack generation */
  let baseCardRows = [];
  try {
    const csvPath = path.resolve(__dirname, '..', '..', 'cards-base.csv');
    const csvRaw = fs.readFileSync(csvPath, 'utf-8');
    baseCardRows = parse(csvRaw, { columns: true, skip_empty_lines: true, trim: true });
    const prices = generateLibraryPrices(baseCardRows);
    libraryCards = baseCardRows.map(card => {
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
    console.log(`Season 1 pack mint-on-demand ready (max supply ${SEASON1_MAX_SUPPLY})`);
  } catch (err) {
    console.error('Failed to load library cards:', err.message);
  }

  /**
   * Build one Season 1 tribe card row (mint-on-demand).
   * Stats match generate-cards.js so pre-seeded and on-demand cards feel the same.
   */
  function buildSeason1CardInstance(baseCard, cardNumber, tribeName) {
    const tribe = tribeName || rollTribe();
    const tribeConfig = TRIBES[tribe] || TRIBES['Iron Will'];
    const traits = rollTraits();
    const bonusAbilities = rollBonusAbilities();

    let attack = 0;
    let health = 0;
    let manaCost = 0;
    if (baseCard.type === 'Minion' || baseCard.type === 'Hero') {
      const rarityMultiplier = {
        Common: 1, CommonHC: 1.2, Uncommon: 1.5, Uncommonhc: 1.5,
        Rare: 2, Epic: 2.5, Legendary: 3, StarterM: 0.5,
      }[baseCard.rarity] || 1;
      attack = Math.max(1, Math.floor((1 + Math.random() * 3) * rarityMultiplier));
      health = Math.max(1, Math.floor((1 + Math.random() * 4) * rarityMultiplier));
      manaCost = Math.max(1, Math.floor(1 + Math.random() * 5 * (rarityMultiplier * 0.6)));
    } else if (baseCard.type === 'Spell') {
      manaCost = Math.max(1, Math.floor(2 + Math.random() * 6));
    } else if (baseCard.type === 'StarterM') {
      attack = 1; health = 1; manaCost = 1;
    }

    const isSignature = tribe === 'Ethereal Signature';
    if (isSignature) {
      attack += 2;
      health += 2;
      manaCost = Math.max(0, manaCost - 1);
    }
    if (traits.life) health += 1;
    if (traits.fire) attack += 1;

    return {
      id: uuidv4(),
      card_number: cardNumber,
      base_card_id: parseInt(baseCard.external_id, 10),
      name: baseCard.name,
      description: baseCard.description || '',
      image_url: baseCard.image,
      rarity: baseCard.rarity,
      type: baseCard.type,
      subtype: baseCard.subtype,
      abilities: baseCard.abilities || '',
      tribe,
      tribe_bg: tribeConfig.background || '',
      tribe_border: tribeConfig.borderColor || '',
      attack,
      health,
      mana_cost: manaCost,
      traits,
      bonus_abilities: bonusAbilities,
      is_signature: isSignature,
      edition: `#${cardNumber}`,
      season: SEASON_TRIBE,
      mint_status: 'unminted',
    };
  }

  // ── GET /api/nexus/library ──────────────────────────────────────
  // Season 0 catalog: fixed GBUX prices, no tribe, unlimited mint-on-demand
  router.get('/library', async (req, res) => {
    try {
      const cards = libraryCards.map(card => ({
        ...card,
        // Library is mint-on-demand Season 0 — always available
        available: null,
        unlimited: true,
        season: SEASON_LIBRARY,
        tribe: null,
      }));

      res.json({
        season: SEASON_LIBRARY,
        scheme: 'no-tribe',
        totalCards: cards.length,
        cards,
      });
    } catch (err) {
      console.error('Library fetch error:', err);
      res.status(500).json({ error: 'Failed to load library' });
    }
  });

  // ── POST /api/nexus/library/buy ─────────────────────────────────
  // Season 0: mint a no-tribe Library instance (does NOT consume Season 1 pool)
  router.post('/library/buy', async (req, res) => {
    const { grudgeId, baseCardId } = req.body;

    if (!grudgeId || !baseCardId) {
      return res.status(400).json({ error: 'grudgeId and baseCardId required' });
    }

    const cardId = parseInt(baseCardId);
    const libCard = libraryCards.find(c => c.id === cardId);
    const baseRow = baseCardRows.find(c => parseInt(c.external_id, 10) === cardId);
    if (!libCard || !baseRow) {
      return res.status(404).json({ error: `Base card ${baseCardId} not found in library` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Prefer reusing an unowned Season 0 / Library copy of this base card
      let assignedCardId = null;
      const { rows: existing } = await client.query(
        `SELECT id FROM nexus_cards
         WHERE base_card_id = $1
           AND owner_grudge_id IS NULL
           AND (season = $2 OR tribe = $3 OR tribe = '' OR tribe IS NULL)
         ORDER BY card_number ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [cardId, SEASON_LIBRARY, LIBRARY_TRIBE]
      );

      if (existing.length > 0) {
        assignedCardId = existing[0].id;
        await client.query(
          `UPDATE nexus_cards
           SET owner_grudge_id = $1,
               tribe = $2,
               tribe_bg = '',
               tribe_border = '',
               season = $3,
               is_signature = FALSE,
               mint_status = 'assigned',
               assigned_at = NOW()
           WHERE id = $4`,
          [grudgeId, LIBRARY_TRIBE, SEASON_LIBRARY, assignedCardId]
        );
      } else {
        // Mint-on-demand Season 0 no-tribe instance (separate card_number sequence)
        const { rows: numRows } = await client.query(
          `SELECT COALESCE(MAX(card_number), 0) + 1 AS next_num FROM nexus_cards`
        );
        const nextNum = parseInt(numRows[0].next_num, 10);
        const id = uuidv4();
        await client.query(
          `INSERT INTO nexus_cards (
             id, card_number, base_card_id, name, description, image_url,
             rarity, type, subtype, abilities, tribe, tribe_bg, tribe_border,
             attack, health, mana_cost, traits, bonus_abilities, is_signature,
             edition, season, mint_status, owner_grudge_id, assigned_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, '', '',
             $12, $13, $14, '{}'::jsonb, '{}', FALSE,
             $15, $16, 'assigned', $17, NOW()
           )`,
          [
            id,
            nextNum,
            cardId,
            libCard.name,
            libCard.description || '',
            libCard.image,
            libCard.rarity,
            libCard.type,
            libCard.subtype,
            libCard.abilities || '',
            LIBRARY_TRIBE,
            0,
            0,
            0,
            `#${nextNum} Library`,
            SEASON_LIBRARY,
            grudgeId,
          ]
        );
        // Fill base combat stats from template ranges lightly
        const inst = buildSeason1CardInstance(baseRow, nextNum, 'Iron Will');
        await client.query(
          `UPDATE nexus_cards
           SET attack = $1, health = $2, mana_cost = $3,
               tribe = $4, tribe_bg = '', tribe_border = '',
               is_signature = FALSE, season = $5
           WHERE id = $6`,
          [inst.attack, inst.health, inst.mana_cost, LIBRARY_TRIBE, SEASON_LIBRARY, id]
        );
        assignedCardId = id;
      }

      await client.query(
        `INSERT INTO nexus_library_purchases (grudge_id, base_card_id, card_id, gbux_price)
         VALUES ($1, $2, $3, $4)`,
        [grudgeId, cardId, assignedCardId, libCard.gbuxPrice]
      );

      await client.query('COMMIT');

      const { rows: cardRows } = await pool.query(
        `SELECT * FROM nexus_cards WHERE id = $1`,
        [assignedCardId]
      );

      res.json({
        purchased: true,
        season: SEASON_LIBRARY,
        tribe: null,
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

      // Season 1 supply: real tribe cards count toward 1,000,000 max
      const { rows: allTribeCount } = await client.query(
        `SELECT COUNT(*)::int AS total FROM nexus_cards
         WHERE tribe IS NOT NULL AND tribe <> $1 AND tribe <> ''`,
        [LIBRARY_TRIBE]
      );
      const totalTribeSupply = allTribeCount[0]?.total || 0;

      // Select unassigned tribe cards (never Library / empty tribe)
      const weights = PACK_TRIBE_WEIGHTS[packType] || PACK_TRIBE_WEIGHTS.starter;
      const tribeOrder = Object.entries(weights).sort((a, b) => b[1] - a[1]);
      const weightSum = tribeOrder.reduce((s, [, w]) => s + w, 0);

      const selectedCardIds = [];
      let remaining = config.cards;

      for (const [tribe, weight] of tribeOrder) {
        const count = Math.max(
          remaining === config.cards ? 1 : 0,
          Math.round(remaining * (weight / weightSum))
        );
        if (count === 0) continue;

        const { rows } = await client.query(
          `SELECT id FROM nexus_cards
           WHERE owner_grudge_id IS NULL
             AND tribe = $1
           ORDER BY RANDOM()
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
          [tribe, Math.min(count, remaining)]
        );

        selectedCardIds.push(...rows.map(r => r.id));
        remaining -= rows.length;
        if (remaining <= 0) break;
      }

      // Fallback: any unassigned real-tribe card (not Library)
      if (remaining > 0) {
        const { rows } = await client.query(
          `SELECT id FROM nexus_cards
           WHERE owner_grudge_id IS NULL
             AND tribe IS NOT NULL AND tribe <> $1 AND tribe <> ''
           ORDER BY RANDOM()
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
          [LIBRARY_TRIBE, remaining]
        );
        selectedCardIds.push(...rows.map(r => r.id));
        remaining -= rows.length;
      }

      // Mint-on-demand: create new Season 1 tribe cards up to 1M supply
      if (remaining > 0 && baseCardRows.length > 0) {
        const room = Math.max(0, SEASON1_MAX_SUPPLY - totalTribeSupply);
        const toCreate = Math.min(remaining, room);
        if (toCreate < remaining && room === 0) {
          // No room and no pool left
        } else if (toCreate > 0) {
          const { rows: numRows } = await client.query(
            `SELECT COALESCE(MAX(card_number), 0) AS max_num FROM nexus_cards`
          );
          let nextNum = parseInt(numRows[0].max_num, 10) + 1;

          for (let i = 0; i < toCreate; i++) {
            const tribe = rollTribe(weights);
            const baseCard = baseCardRows[Math.floor(Math.random() * baseCardRows.length)];
            const inst = buildSeason1CardInstance(baseCard, nextNum++, tribe);
            const bonusArr = inst.bonus_abilities.length > 0
              ? inst.bonus_abilities
              : [];

            await client.query(
              `INSERT INTO nexus_cards (
                 id, card_number, base_card_id, name, description, image_url,
                 rarity, type, subtype, abilities, tribe, tribe_bg, tribe_border,
                 attack, health, mana_cost, traits, bonus_abilities, is_signature,
                 edition, season, mint_status
               ) VALUES (
                 $1, $2, $3, $4, $5, $6,
                 $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17::jsonb, $18, $19,
                 $20, $21, 'unminted'
               )`,
              [
                inst.id,
                inst.card_number,
                inst.base_card_id,
                inst.name,
                inst.description,
                inst.image_url,
                inst.rarity,
                inst.type,
                inst.subtype,
                inst.abilities,
                inst.tribe,
                inst.tribe_bg,
                inst.tribe_border,
                inst.attack,
                inst.health,
                inst.mana_cost,
                JSON.stringify(inst.traits),
                bonusArr,
                inst.is_signature,
                inst.edition,
                SEASON_TRIBE,
              ]
            );
            selectedCardIds.push(inst.id);
            remaining--;
          }
        }
      }

      if (selectedCardIds.length === 0) {
        await client.query('ROLLBACK');
        return res.status(503).json({
          error: totalTribeSupply >= SEASON1_MAX_SUPPLY
            ? 'Season 1 tribe supply is sold out (1,000,000).'
            : 'No Season 1 tribe cards available to open.',
        });
      }

      // Assign cards to user + mark as minting; force Season 1 + keep real tribe
      await client.query(
        `UPDATE nexus_cards
         SET owner_grudge_id = $1,
             owner_wallet = $2,
             mint_status = 'minting',
             assigned_at = NOW(),
             season = $3
         WHERE id = ANY($4::uuid[])`,
        [grudgeId, wallet || null, SEASON_TRIBE, selectedCardIds]
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
        season: SEASON_TRIBE,
        scheme: 'tribe',
        gbuxCost: config.cost,
        cardsReceived: cards.length,
        cards: cards.map(formatCard),
        minting: mintResults,
        maxSupply: SEASON1_MAX_SUPPLY,
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
  // Collection statistics — Season 0 library vs Season 1 tribe packs
  router.get('/stats', async (req, res) => {
    try {
      const [total, byTribe, byRarity, byStatus, bySeason, tribePool, ownedTribe] = await Promise.all([
        pool.query(`SELECT COUNT(*) as total FROM nexus_cards`),
        pool.query(`SELECT tribe, COUNT(*) as count FROM nexus_cards GROUP BY tribe ORDER BY count DESC`),
        pool.query(`SELECT rarity, COUNT(*) as count FROM nexus_cards GROUP BY rarity ORDER BY count DESC`),
        pool.query(`SELECT mint_status, COUNT(*) as count FROM nexus_cards GROUP BY mint_status`),
        pool.query(`SELECT COALESCE(season, 'unknown') as season, COUNT(*) as count FROM nexus_cards GROUP BY season ORDER BY count DESC`),
        pool.query(
          `SELECT COUNT(*)::int as total FROM nexus_cards
           WHERE tribe IS NOT NULL AND tribe <> $1 AND tribe <> ''`,
          [LIBRARY_TRIBE]
        ),
        pool.query(
          `SELECT COUNT(*)::int as total FROM nexus_cards
           WHERE owner_grudge_id IS NOT NULL
             AND tribe IS NOT NULL AND tribe <> $1 AND tribe <> ''`,
          [LIBRARY_TRIBE]
        ),
      ]);

      const tribeTotal = tribePool.rows[0]?.total || 0;
      const tribeOwned = ownedTribe.rows[0]?.total || 0;

      res.json({
        total: parseInt(total.rows[0].total),
        byTribe: Object.fromEntries(byTribe.rows.map(r => [r.tribe, parseInt(r.count)])),
        byRarity: Object.fromEntries(byRarity.rows.map(r => [r.rarity, parseInt(r.count)])),
        byStatus: Object.fromEntries(byStatus.rows.map(r => [r.mint_status, parseInt(r.count)])),
        bySeason: Object.fromEntries(bySeason.rows.map(r => [r.season, parseInt(r.count)])),
        seasonLibrary: SEASON_LIBRARY,
        seasonPacks: SEASON_TRIBE,
        season: SEASON_TRIBE,
        scheme: {
          season0: 'Library / legacy decks — no tribe',
          season1: 'Pack openings — tribe cards from 1,000,000 supply',
        },
        maxSupply: SEASON1_MAX_SUPPLY,
        maxCount: SEASON1_MAX_SUPPLY,
        tribeSupply: tribeTotal,
        tribeOwned,
        remainingCards: Math.max(0, SEASON1_MAX_SUPPLY - tribeTotal),
        totalMinted: tribeOwned,
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
  const isLibrary =
    row.tribe === LIBRARY_TRIBE ||
    row.tribe === '' ||
    row.tribe == null ||
    row.season === SEASON_LIBRARY;
  const tribeConfig = (!isLibrary && TRIBES[row.tribe]) || {};
  const season =
    row.season ||
    (isLibrary ? SEASON_LIBRARY : SEASON_TRIBE);
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
    // Season 0 library/legacy: no tribe for gameplay
    tribe: isLibrary ? null : row.tribe,
    tribeBg: isLibrary ? '' : row.tribe_bg,
    tribeBorder: isLibrary ? '' : row.tribe_border,
    tribeUpgrade: tribeConfig.upgrade || null,
    tribeSpell: tribeConfig.spell || null,
    isTribal: !isLibrary && !!row.tribe && row.tribe !== LIBRARY_TRIBE,
    attack: row.attack,
    health: row.health,
    manaCost: row.mana_cost,
    traits: row.traits,
    bonusAbilities: row.bonus_abilities,
    isSignature: row.is_signature,
    edition: row.edition,
    season,
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
