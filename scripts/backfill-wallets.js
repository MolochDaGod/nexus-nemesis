#!/usr/bin/env node
const { Pool } = require('pg');
const { spawnSync } = require('child_process');

const gameDir = require('path').resolve(__dirname, '..', '..', 'nexus-nemesis-game');
const r = spawnSync('railway', ['variables', '--service', 'nexus-nemesis-game', '--environment', 'production', '--json'], {
  encoding: 'utf8', shell: true, cwd: gameDir,
});
const vars = JSON.parse(r.stdout);
const pool = new Pool({ connectionString: vars.DATABASE_PUBLIC_URL.trim(), ssl: { rejectUnauthorized: false } });
const key = vars.CROSSMINT_SERVER_API_KEY || vars.CROSSMINT_API_KEY;
const BASE = 'https://www.crossmint.com/api/2022-06-09';

function resolveUserEmail(emailOrUsername) {
  const trimmed = (emailOrUsername || '').trim();
  if (!trimmed) return 'unknown@nexus.game';
  return trimmed.includes('@') ? trimmed : `${trimmed}@nexus.game`;
}

function buildBody(chain, emailOrUsername) {
  const email = resolveUserEmail(emailOrUsername);
  const type = chain === 'solana' ? 'solana-smart-wallet' : 'evm-smart-wallet';
  return {
    type,
    config: { adminSigner: { type: 'email', email } },
    linkedUser: `email:${email}`,
  };
}

async function createWallet(emailOrUsername, chain) {
  const res = await fetch(`${BASE}/wallets`, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(chain, emailOrUsername)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${chain} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

(async () => {
  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.email FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id)
    ORDER BY u.id
  `);
  console.log(`Users needing wallets: ${rows.length}`);
  for (const u of rows) {
    const identifier = u.email || u.username;
    try {
      for (const chain of ['solana', 'polygon']) {
        const existing = await pool.query(
          `SELECT 1 FROM wallets WHERE user_id = $1 AND blockchain = $2 LIMIT 1`,
          [u.id, chain]
        );
        if (existing.rowCount > 0) {
          console.log(`SKIP ${u.username} ${chain}: already exists`);
          continue;
        }
        const data = await createWallet(identifier, chain);
        await pool.query(
          `INSERT INTO wallets (user_id, address, blockchain, provider, status, is_active, created_at)
           VALUES ($1,$2,$3,'crossmint','active',true,NOW())`,
          [u.id, data.address, chain]
        );
        console.log(`OK ${u.username} ${chain}: ${data.address}`);
      }
    } catch (e) {
      console.error(`FAIL ${u.username}:`, e.message);
    }
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });