#!/usr/bin/env node
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf8');
const dbUrl = env.match(/DATABASE_URL=(.+)/)?.[1]?.trim();
if (!dbUrl) { console.error('No DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

(async () => {
  await pool.query(fs.readFileSync(path.resolve(__dirname, 'create-tables.sql'), 'utf8'));
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'nexus%'");
  console.log('nexus tables:', tables.rows.map(r => r.tablename).join(', '));
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM nexus_cards');
  console.log('card count:', count.rows[0].count);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });