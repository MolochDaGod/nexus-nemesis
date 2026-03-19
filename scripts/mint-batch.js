#!/usr/bin/env node
// Nexus Nemesis — Batch Mint 100K cNFTs via Crossmint
// Usage: node scripts/mint-batch.js [--limit 1000] [--resume]
// Requires: CROSSMINT_API_KEY, CROSSMINT_COLLECTION_ID, ADMIN_WALLET_ADDRESS, DATABASE_URL in .env

require('dotenv').config();
const { Pool } = require('pg');
const fetch = require('node-fetch');

const CROSSMINT_API = 'https://www.crossmint.com/api/2022-06-09';
const BATCH_SIZE = 10;       // Crossmint rate limit ~10 req/sec
const DELAY_MS = 1100;       // Slightly over 1s to be safe
const MAX_RETRIES = 3;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Parse CLI args
const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : null;
const RESUME = args.includes('--resume');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mintCard(card) {
  const metadata = {
    name: `${card.name} ${card.edition}`,
    image: card.image_url,
    description: card.description,
    attributes: [
      { trait_type: 'Card Number', value: card.card_number.toString() },
      { trait_type: 'Rarity', value: card.rarity },
      { trait_type: 'Type', value: card.type },
      { trait_type: 'SubType', value: card.subtype },
      { trait_type: 'Tribe', value: card.tribe },
      { trait_type: 'Attack', value: card.attack.toString() },
      { trait_type: 'Health', value: card.health.toString() },
      { trait_type: 'Mana Cost', value: card.mana_cost.toString() },
      { trait_type: 'Abilities', value: card.abilities || 'None' },
      { trait_type: 'Season', value: card.season },
      { trait_type: 'Edition', value: card.edition },
      { trait_type: 'Signature', value: card.is_signature ? 'Yes' : 'No' },
      ...(card.traits.life ? [{ trait_type: 'Trait: Life', value: '+1 Health' }] : []),
      ...(card.traits.fire ? [{ trait_type: 'Trait: Fire', value: '+1 Attack' }] : []),
      ...(card.traits.foil ? [{ trait_type: 'Trait: Foil', value: 'Cosmetic' }] : []),
      ...card.bonus_abilities.map(a => ({ trait_type: 'Bonus Ability', value: a })),
    ],
  };

  const body = {
    recipient: `solana:${process.env.ADMIN_WALLET_ADDRESS}`,
    metadata,
    compressed: true, // cNFT
  };

  const res = await fetch(
    `${CROSSMINT_API}/collections/${process.env.CROSSMINT_COLLECTION_ID}/nfts`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': process.env.CROSSMINT_API_KEY,
      },
      body: JSON.stringify(body),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Crossmint error ${res.status}: ${JSON.stringify(data)}`);
  }

  return data; // { id, actionId, ... }
}

async function run() {
  // Validate env
  for (const key of ['CROSSMINT_API_KEY', 'CROSSMINT_COLLECTION_ID', 'ADMIN_WALLET_ADDRESS', 'DATABASE_URL']) {
    if (!process.env[key]) {
      console.error(`Missing env var: ${key}`);
      process.exit(1);
    }
  }

  // Fetch unminted cards
  let query = `SELECT * FROM nexus_cards WHERE mint_status = 'unminted' ORDER BY card_number ASC`;
  if (LIMIT) query += ` LIMIT ${LIMIT}`;

  const { rows: cards } = await pool.query(query);
  console.log(`Found ${cards.length} unminted cards to mint`);

  if (cards.length === 0) {
    console.log('Nothing to mint!');
    return;
  }

  let minted = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (card) => {
        let lastErr;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const result = await mintCard(card);

            // Update DB
            await pool.query(
              `UPDATE nexus_cards SET mint_status = 'minted', crossmint_id = $1, minted_at = NOW() WHERE id = $2`,
              [result.actionId || result.id, card.id]
            );

            // Log mint
            await pool.query(
              `INSERT INTO nexus_mint_log (card_id, crossmint_action_id, crossmint_status, admin_wallet)
               VALUES ($1, $2, 'success', $3)`,
              [card.id, result.actionId || result.id, process.env.ADMIN_WALLET_ADDRESS]
            );

            return { success: true, cardNumber: card.card_number };
          } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRIES) {
              console.warn(`  Retry ${attempt}/${MAX_RETRIES} for card #${card.card_number}: ${err.message}`);
              await sleep(2000 * attempt); // Exponential backoff
            }
          }
        }

        // All retries failed
        await pool.query(
          `INSERT INTO nexus_mint_log (card_id, crossmint_status, admin_wallet, error_message)
           VALUES ($1, 'failed', $2, $3)`,
          [card.id, process.env.ADMIN_WALLET_ADDRESS, lastErr.message]
        );
        return { success: false, cardNumber: card.card_number, error: lastErr.message };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) {
        minted++;
      } else {
        failed++;
        const err = r.status === 'rejected' ? r.reason : r.value?.error;
        console.error(`  FAILED card: ${err}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (minted / (elapsed || 1)).toFixed(1);
    const eta = ((cards.length - i - batch.length) / (rate || 1) / 60).toFixed(1);
    console.log(`[${elapsed}s] Minted: ${minted}/${cards.length} | Failed: ${failed} | Rate: ${rate}/s | ETA: ${eta}m`);

    // Rate limit delay
    await sleep(DELAY_MS);
  }

  console.log(`\n=== MINT COMPLETE ===`);
  console.log(`Minted: ${minted} | Failed: ${failed} | Total time: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)}m`);

  await pool.end();
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
