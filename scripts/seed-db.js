#!/usr/bin/env node
// Seed DB: create tables + import 100K cards
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Read DATABASE_URL from .env.local (pulled from Vercel production)
const envPath = path.resolve(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const dbLine = envContent.split('\n').find(l => l.startsWith('DATABASE_URL='));
if (!dbLine) { console.error('No DATABASE_URL in .env.local'); process.exit(1); }
const dbUrl = dbLine.replace('DATABASE_URL=', '').replace(/^"|"$/g, '').trim();

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log('Connecting to DB...');
  await pool.query('SELECT 1');
  console.log('Connected.\n');

  // Step 1: Create tables
  console.log('=== Creating tables ===');
  const schemaSql = fs.readFileSync(path.resolve(__dirname, 'create-tables.sql'), 'utf-8');
  await pool.query(schemaSql);
  const { rows: tables } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  console.log('Tables:', tables.map(r => r.tablename).join(', '));

  // Step 2: Check if cards already imported
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*) as count FROM nexus_cards');
  const cardCount = parseInt(count);
  console.log(`\nExisting cards in DB: ${cardCount}`);

  if (cardCount >= 100000) {
    console.log('100K cards already imported. Skipping.');
  } else if (cardCount > 0) {
    console.log(`Partial import detected (${cardCount} cards). Truncating and re-importing...`);
    await pool.query('TRUNCATE nexus_cards CASCADE');
    await importCards();
  } else {
    await importCards();
  }

  // Step 3: Verify
  console.log('\n=== Verification ===');
  const [total, byTribe, byRarity] = await Promise.all([
    pool.query('SELECT COUNT(*) as count FROM nexus_cards'),
    pool.query('SELECT tribe, COUNT(*) as count FROM nexus_cards GROUP BY tribe ORDER BY count DESC'),
    pool.query('SELECT rarity, COUNT(*) as count FROM nexus_cards GROUP BY rarity ORDER BY count DESC'),
  ]);

  console.log(`Total cards: ${total.rows[0].count}`);
  console.log('\nBy Tribe:');
  for (const r of byTribe.rows) console.log(`  ${r.tribe}: ${r.count}`);
  console.log('\nBy Rarity:');
  for (const r of byRarity.rows) console.log(`  ${r.rarity}: ${r.count}`);

  await pool.end();
  console.log('\nDone!');
}

async function importCards() {
  const sqlPath = path.resolve(__dirname, '..', 'output', 'nexus_cards_100k.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error(`SQL file not found: ${sqlPath}`);
    console.error('Run "npm run generate" first to create the 100K card data.');
    process.exit(1);
  }

  console.log('\n=== Importing 100K cards ===');
  const sqlContent = fs.readFileSync(sqlPath, 'utf-8');

  // Split into individual INSERT batches (separated by semicolons)
  const statements = sqlContent.split(';').filter(s => s.trim().startsWith('INSERT'));
  console.log(`Found ${statements.length} INSERT batches`);

  let imported = 0;
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim() + ';';
    try {
      await pool.query(stmt);
      imported++;
      if (imported % 20 === 0 || i === statements.length - 1) {
        process.stdout.write(`\r  Imported batch ${imported}/${statements.length}`);
      }
    } catch (err) {
      console.error(`\nError on batch ${i + 1}: ${err.message.substring(0, 200)}`);
      throw err;
    }
  }
  console.log('\n  Import complete.');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
