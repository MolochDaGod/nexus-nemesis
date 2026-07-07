#!/usr/bin/env node
/** Re-sync card API Vercel env from Railway (trimmed values). */
import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const gameDir = 'C:\\Users\\david\\Desktop\\nexus-nemesis-game';
const cardDir = 'C:\\Users\\david\\Desktop\\nexus-nemesis';

const r = spawnSync(
  'railway',
  ['variables', '--service', 'nexus-nemesis-game', '--environment', 'production', '--json'],
  { encoding: 'utf8', shell: true, cwd: gameDir }
);
if (r.status !== 0) throw new Error('Railway vars failed');
const rv = JSON.parse(r.stdout);

const envMap = {
  DATABASE_URL: rv.DATABASE_URL,
  CROSSMINT_API_KEY: (rv.CROSSMINT_SERVER_API_KEY || rv.CROSSMINT_API_KEY || '').trim(),
  CROSSMINT_COLLECTION_ID: (rv.CROSSMINT_CARD_COLLECTION_ID || rv.CROSSMINT_COLLECTION_ID || '').trim(),
  CROSSMINT_WEBHOOK_SECRET: (rv.CROSSMINT_WEBHOOK_SECRET || '').trim(),
  GRUDGE_JWT_SECRET: (rv.JWT_SECRET || '').trim(),
  GRUDGE_AUTH_URL: 'https://id.grudge-studio.com',
};

for (const [key, value] of Object.entries(envMap)) {
  if (!value) {
    console.log('SKIP', key);
    continue;
  }
  const tmp = join(cardDir, `.env-sync-${key}.tmp`);
  writeFileSync(tmp, value, 'utf8');
  const add = spawnSync(`type "${tmp}" | vercel env add ${key} production --force --yes`, {
    shell: true,
    cwd: cardDir,
    encoding: 'utf8',
  });
  unlinkSync(tmp);
  if (add.status !== 0) throw new Error(`Failed to set ${key}`);
  console.log('SET', key);
}

const deploy = spawnSync('vercel', ['deploy', '--prod', '--yes'], { cwd: cardDir, encoding: 'utf8', shell: true });
if (deploy.status !== 0) throw new Error('deploy failed');
console.log('Deployed:', (deploy.stdout || '').split('\n').filter(Boolean).pop());