#!/usr/bin/env node
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const gameVars = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'nexus-nemesis-game', '.railway-vars.json'), 'utf8')
);
const dbUrl = (gameVars.DATABASE_PUBLIC_URL || gameVars.DATABASE_URL || '').trim();
const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

(async () => {
  const sql = `
    UPDATE user_season0_cards
    SET obtained_from = 'beta_migration',
        is_tribal = false,
        tribal_type = NULL
    WHERE obtained_from NOT IN ('cnft_pack_redeem', 'premium_pack', 'legendary_pack')
  `;
  const result = await pool.query(sql);
  console.log(`Migrated ${result.rowCount} legacy cards → season0 no-tribe`);

  const summary = await pool.query(`
    SELECT obtained_from, COUNT(*)::int AS count
    FROM user_season0_cards
    GROUP BY obtained_from ORDER BY count DESC
  `);
  console.log('By source:', summary.rows);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });