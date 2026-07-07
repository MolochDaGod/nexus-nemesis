#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const cardDir = 'C:\\Users\\david\\Desktop\\nexus-nemesis';
const gameDir = 'C:\\Users\\david\\Desktop\\nexus-nemesis-game';
const r = spawnSync(
  'railway',
  ['variables', '--service', 'nexus-nemesis-game', '--environment', 'production', '--json'],
  { encoding: 'utf8', shell: true, cwd: gameDir }
);
if (r.status !== 0) throw new Error('Railway vars failed');
const jwt = JSON.parse(r.stdout).JWT_SECRET;
if (!jwt) throw new Error('JWT_SECRET missing');

const tmp = join(cardDir, '.jwt-sync.tmp');
writeFileSync(tmp, jwt, 'utf8');

const add = spawnSync(
  `type "${tmp}" | vercel env add GRUDGE_JWT_SECRET production --force --yes`,
  { shell: true, cwd: cardDir, encoding: 'utf8' }
);
unlinkSync(tmp);

if (add.status !== 0) {
  console.error(add.stdout, add.stderr);
  throw new Error('vercel env add failed');
}
console.log('GRUDGE_JWT_SECRET synced');

const deploy = spawnSync('vercel', ['deploy', '--prod', '--yes'], { cwd: cardDir, encoding: 'utf8', shell: true });
console.log(deploy.stdout?.slice(-500) || '');
if (deploy.status !== 0) {
  console.error(deploy.stderr);
  throw new Error('vercel deploy failed');
}
console.log('Card API redeployed');