#!/usr/bin/env node
// Nexus Nemesis — Batch Mint 100K cNFTs via Crossmint Template
// Uses idempotent minting (card UUID = mint ID) to guarantee no double-mints.
//
// Usage:
//   node scripts/mint-batch.js                    # mint all unminted
//   node scripts/mint-batch.js --limit 100        # mint next 100
//   node scripts/mint-batch.js --dry-run          # preview without minting
//
// Requires env: CROSSMINT_API_KEY, CROSSMINT_COLLECTION_ID,
//               CROSSMINT_TEMPLATE_ID, ADMIN_WALLET_ADDRESS, DATABASE_URL

require('dotenv').config();
const { Pool } = require('pg');
const { mintCardToRecipient } = require('../server/lib/crossmint');

// ── Config ───────────────────────────────────────────────────────────
const CROSSMINT_API = 'https://www.crossmint.com/api/2022-06-09';
const HARD_CAP = 100_000;    // Absolute maximum — Season 0 supply
const BATCH_SIZE = 10;       // Concurrent mints per batch
const DELAY_MS = 1100;       // 1.1s between batches (rate limit safe)
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;  // Exponential backoff base

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── CLI args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : null;
const DRY_RUN = args.includes('--dry-run');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Uses shared Crossmint lib for idempotent minting

// ── Main ────────────────────────────────────────────────────────────
async function run() {
  // Validate required env
  const required = [
    'CROSSMINT_API_KEY', 'CROSSMINT_COLLECTION_ID',
    'ADMIN_WALLET_ADDRESS', 'DATABASE_URL',
  ];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing env var: ${key}`);
      process.exit(1);
    }
  }

  console.log('Nexus Nemesis — cNFT Batch Minter (Admin Fallback)');
  console.log(`  Collection: ${process.env.CROSSMINT_COLLECTION_ID}`);
  console.log(`  Admin:      ${process.env.ADMIN_WALLET_ADDRESS}`);
  console.log(`  Hard cap:   ${HARD_CAP.toLocaleString()}`);
  if (DRY_RUN) console.log('  MODE: DRY RUN (no actual mints)');
  console.log();

  // Safety check: count total minted so far
  const { rows: [{ count: totalMinted }] } = await pool.query(
    `SELECT COUNT(*) as count FROM nexus_cards WHERE mint_status IN ('minted', 'pending')`
  );
  console.log(`Already minted/pending: ${totalMinted}`);

  if (parseInt(totalMinted) >= HARD_CAP) {
    console.log('HARD CAP reached. All 100,000 cards have been minted. Exiting.');
    return;
  }

  // Fetch unminted cards
  const remaining = HARD_CAP - parseInt(totalMinted);
  const fetchLimit = LIMIT ? Math.min(LIMIT, remaining) : remaining;

  const { rows: cards } = await pool.query(
    `SELECT * FROM nexus_cards WHERE mint_status = 'unminted' ORDER BY card_number ASC LIMIT $1`,
    [fetchLimit]
  );
  console.log(`Queued ${cards.length} cards to mint (cap remaining: ${remaining})\n`);

  if (cards.length === 0) {
    console.log('No unminted cards found.');
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — first 5 cards that would be minted:');
    for (const c of cards.slice(0, 5)) {
      console.log(`  #${c.card_number} ${c.name} | ${c.tribe} | ${c.rarity} | UUID: ${c.id}`);
    }
    console.log(`\n...and ${cards.length - 5} more. Run without --dry-run to mint.`);
    return;
  }

  let minted = 0;
  let skipped = 0; // Already minted (idempotent)
  let failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (card) => {
        // Mark as pending before attempting
        await pool.query(
          `UPDATE nexus_cards SET mint_status = 'pending' WHERE id = $1 AND mint_status = 'unminted'`,
          [card.id]
        );

        let lastErr;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const result = await mintCardToRecipient(card, { wallet: process.env.ADMIN_WALLET_ADDRESS });

            if (result.alreadyMinted) {
              // Idempotent hit — already minted, just update status
              await pool.query(
                `UPDATE nexus_cards SET mint_status = 'minted', crossmint_id = $1 WHERE id = $2`,
                [result.actionId, card.id]
              );
              return { success: true, cardNumber: card.card_number, skipped: true };
            }

            // New mint succeeded
            await pool.query(
              `UPDATE nexus_cards SET mint_status = 'minted', crossmint_id = $1, minted_at = NOW() WHERE id = $2`,
              [result.actionId, card.id]
            );

            await pool.query(
              `INSERT INTO nexus_mint_log (card_id, crossmint_action_id, crossmint_status, recipient_wallet)
               VALUES ($1, $2, 'pending', $3)
               ON CONFLICT (card_id) DO UPDATE SET crossmint_action_id = $2, crossmint_status = 'pending', recipient_wallet = $3`,
              [card.id, result.actionId, process.env.ADMIN_WALLET_ADDRESS]
            );

            return { success: true, cardNumber: card.card_number, skipped: false };
          } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRIES) {
              console.warn(`  Retry ${attempt}/${MAX_RETRIES} card #${card.card_number}: ${err.message}`);
              await sleep(RETRY_BASE_MS * attempt);
            }
          }
        }

        // All retries failed — revert to unminted so it can be retried later
        await pool.query(
          `UPDATE nexus_cards SET mint_status = 'unminted' WHERE id = $1`,
          [card.id]
        );
        await pool.query(
          `INSERT INTO nexus_mint_log (card_id, crossmint_status, recipient_wallet, error_message)
           VALUES ($1, 'failed', $2, $3)
           ON CONFLICT (card_id) DO UPDATE SET crossmint_status = 'failed', error_message = $3`,
          [card.id, process.env.ADMIN_WALLET_ADDRESS, lastErr.message]
        );
        return { success: false, cardNumber: card.card_number, error: lastErr.message };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) {
        if (r.value.skipped) skipped++;
        else minted++;
      } else {
        failed++;
        const err = r.status === 'rejected' ? r.reason?.message : r.value?.error;
        console.error(`  FAILED card #${r.value?.cardNumber || '?'}: ${err}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const total = minted + skipped;
    const rate = (total / (parseFloat(elapsed) || 1)).toFixed(1);
    const etaMin = ((cards.length - i - batch.length) / (parseFloat(rate) || 1) / 60).toFixed(1);
    console.log(
      `[${elapsed}s] New: ${minted} | Skipped: ${skipped} | Failed: ${failed}` +
      ` | ${total}/${cards.length} | ${rate}/s | ETA: ${etaMin}m`
    );

    await sleep(DELAY_MS);
  }

  console.log('\n=== MINT COMPLETE ===');
  console.log(`New mints: ${minted}`);
  console.log(`Idempotent skips: ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total time: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)}m`);

  await pool.end();
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
