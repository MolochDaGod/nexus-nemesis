#!/usr/bin/env node
/**
 * Apply Season 0 (no-tribe library) / Season 1 (tribe packs, 1M) scheme to nexus_cards.
 * Usage: node scripts/migrate-season-scheme.js
 * Requires DATABASE_URL (or .env.local from vercel env pull).
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function loadDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  for (const f of ['.env.local', '.env']) {
    const p = path.resolve(__dirname, '..', f);
    if (!fs.existsSync(p)) continue;
    const line = fs.readFileSync(p, 'utf8').split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
    if (line) return line.replace(/^DATABASE_URL=/, '').replace(/^["']|["']$/g, '').trim();
  }
  return null;
}

async function main() {
  const dbUrl = loadDbUrl();
  if (!dbUrl) {
    console.error('No DATABASE_URL found');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const sql = fs.readFileSync(path.resolve(__dirname, 'migrate-season-scheme.sql'), 'utf8');

  console.log('Applying season scheme migration...');
  await pool.query(sql);

  const summary = await pool.query(`
    SELECT
      season,
      tribe,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE owner_grudge_id IS NULL)::int AS unowned
    FROM nexus_cards
    GROUP BY season, tribe
    ORDER BY season, count DESC
  `);
  console.table(summary.rows);

  const totals = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE tribe IS NOT NULL AND tribe <> 'Library' AND tribe <> '')::int AS tribe_cards,
      COUNT(*) FILTER (WHERE tribe = 'Library' OR tribe IS NULL OR tribe = '')::int AS no_tribe,
      COUNT(*) FILTER (WHERE season = 'Season 1')::int AS season1,
      COUNT(*) FILTER (WHERE season = 'Season 0')::int AS season0
    FROM nexus_cards
  `);
  console.log('Totals:', totals.rows[0]);
  console.log('Season 1 max supply target: 1,000,000 (mint-on-demand fills the rest)');

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
