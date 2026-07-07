#!/usr/bin/env node
const { Pool } = require('pg');
const { randomBytes } = require('crypto');
const { spawnSync } = require('child_process');

const r = spawnSync('railway', ['variables', '--service', 'Postgres', '--environment', 'production', '--json'], {
  encoding: 'utf8',
  shell: true,
  cwd: require('path').resolve(__dirname, '..', '..', 'nexus-nemesis-game'),
});
const vars = JSON.parse(r.stdout);
const pool = new Pool({
  connectionString: vars.DATABASE_PUBLIC_URL.trim(),
  ssl: { rejectUnauthorized: false },
});

(async () => {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS grudge_id VARCHAR(50)`);
  const { rows } = await pool.query(`SELECT id, username FROM users WHERE grudge_id IS NULL OR grudge_id = ''`);
  console.log(`Users missing Grudge ID: ${rows.length}`);
  for (const u of rows) {
    const gid = `GID-${randomBytes(4).toString('hex')}`;
    await pool.query(`UPDATE users SET grudge_id = $1 WHERE id = $2`, [gid, u.id]);
    console.log(`${u.username} -> ${gid}`);
  }
  const wallets = await pool.query(`
    SELECT COUNT(*)::int AS total FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id)
  `);
  console.log(`Users still missing wallets: ${wallets.rows[0].total}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });