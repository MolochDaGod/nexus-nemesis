#!/usr/bin/env node
/**
 * Upload Nexus tribe backgrounds/emblems from imgur to Cloudflare R2.
 * Serves via https://assets.grudge-studio.com/nexus/tribes/{name}.png
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const CDN_BASE = process.env.NEXUS_CDN_BASE || 'https://assets.grudge-studio.com';
const R2_PREFIX = 'nexus/tribes';
const BUCKET = 'grudge-assets';
const TMP_DIR = join(root, '.tribe-migrate-tmp');

const TRIBE_ASSETS = [
  { key: 'iron-will-bg', url: 'https://i.imgur.com/QPQXtX5.png' },
  { key: 'tribal-war-bg', url: 'https://i.imgur.com/yPR4E8e.png' },
  { key: 'fabled-bg', url: 'https://i.imgur.com/G0hXKXn.png' },
  { key: 'blood-for-conquest-bg', url: 'https://i.imgur.com/FqkZqZb.png' },
  { key: 'ethereal-signature-bg', url: 'https://i.imgur.com/o0d99bB.png' },
  { key: 'emblem', url: 'https://i.imgur.com/SRoq392.png' },
  { key: 'middle-emblem', url: 'https://i.imgur.com/48to9zn.png' },
];

function cdnUrl(key, ext = 'png') {
  return `${CDN_BASE}/${R2_PREFIX}/${key}.${ext}`;
}

function r2Key(key, ext = 'png') {
  return `${R2_PREFIX}/${key}.${ext}`;
}

async function downloadImage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'NexusNemesisTribeMigrate/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const ct = res.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType: ct, ext: ct.includes('jpeg') ? 'jpg' : 'png' };
}

function uploadToR2(key, filePath, contentType) {
  const cmd = [
    'r2', 'object', 'put', `${BUCKET}/${key}`,
    `--file=${filePath}`,
    `--content-type=${contentType}`,
    '--remote',
  ];
  const r = spawnSync('wrangler', cmd, { encoding: 'utf8', shell: true, cwd: root });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'wrangler r2 put failed');
}

async function verifyCdn(url) {
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
  return res.ok;
}

if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const mapping = {};
let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const asset of TRIBE_ASSETS) {
  const targetUrl = cdnUrl(asset.key);
  mapping[asset.url] = targetUrl;

  try {
    const already = await verifyCdn(targetUrl);
    if (already) {
      console.log(`SKIP exists ${targetUrl}`);
      skipped++;
      continue;
    }

    const { buf, contentType, ext } = await downloadImage(asset.url);
    const key = r2Key(asset.key, ext);
    const finalUrl = cdnUrl(asset.key, ext);
    mapping[asset.url] = finalUrl;

    const tmpFile = join(TMP_DIR, `${asset.key}.${ext}`);
    writeFileSync(tmpFile, buf);
    uploadToR2(key, tmpFile, contentType);

    const ok = await verifyCdn(finalUrl);
    if (!ok) throw new Error('CDN HEAD failed after upload');
    console.log(`OK ${asset.key} -> ${finalUrl}`);
    uploaded++;
  } catch (e) {
    console.log(`FAIL ${asset.key} (${asset.url}): ${e.message}`);
    failed++;
  }
}

writeFileSync(join(root, 'scripts', 'tribe-image-url-mapping.json'), JSON.stringify(mapping, null, 2));
console.log('\n=== Tribe Summary ===', { uploaded, skipped, failed });
process.exit(failed > 0 ? 1 : 0);