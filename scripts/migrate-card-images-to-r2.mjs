#!/usr/bin/env node
/**
 * Download Nexus card art from imgur and upload to Cloudflare R2 (grudge-assets).
 * Serves via https://assets.grudge-studio.com/nexus/cards/{id}.png
 *
 * Usage:
 *   node scripts/migrate-card-images-to-r2.mjs              # upload only
 *   node scripts/migrate-card-images-to-r2.mjs --update-db  # upload + patch Postgres
 *   node scripts/migrate-card-images-to-r2.mjs --dry-run    # preview mapping
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import { spawnSync } from 'child_process';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const CDN_BASE = process.env.NEXUS_CDN_BASE || 'https://assets.grudge-studio.com';
const R2_PREFIX = 'nexus/cards';
const BUCKET = 'grudge-assets';
const TMP_DIR = join(root, '.image-migrate-tmp');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const updateDb = args.has('--update-db');

function log(msg) {
  console.log(msg);
}

function readCardsBase() {
  const csv = readFileSync(join(root, 'cards-base.csv'), 'utf8');
  return parse(csv, { columns: true, skip_empty_lines: true, trim: true });
}

function cdnUrl(cardId, ext = 'png') {
  return `${CDN_BASE}/${R2_PREFIX}/${cardId}.${ext}`;
}

function r2Key(cardId, ext = 'png') {
  return `${R2_PREFIX}/${cardId}.${ext}`;
}

async function downloadImage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'NexusNemesisImageMigrate/1.0' },
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
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || 'wrangler r2 put failed');
  }
}

async function verifyCdn(url) {
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
  return res.ok;
}

const cards = readCardsBase();
const mapping = new Map(); // old imgur url -> new cdn url

if (!dryRun && !existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

let uploaded = 0;
let skipped = 0;
let failed = 0;

for (const card of cards) {
  const id = card.external_id;
  const oldUrl = card.image?.trim();
  if (!id || !oldUrl) continue;

  if (mapping.has(oldUrl)) {
    card._newImage = mapping.get(oldUrl);
    continue;
  }

  const targetUrl = cdnUrl(id);
  card._newImage = targetUrl;
  mapping.set(oldUrl, targetUrl);

  if (dryRun) {
    log(`[dry-run] ${id}: ${oldUrl} -> ${targetUrl}`);
    continue;
  }

  // Skip if already on CDN
  if (oldUrl.startsWith(CDN_BASE)) {
    skipped++;
    continue;
  }

  try {
    const already = await verifyCdn(targetUrl);
    if (already) {
      log(`SKIP exists ${targetUrl}`);
      skipped++;
      continue;
    }

    const { buf, contentType, ext } = await downloadImage(oldUrl);
    const key = r2Key(id, ext);
    const finalUrl = cdnUrl(id, ext);
    card._newImage = finalUrl;
    mapping.set(oldUrl, finalUrl);

    const tmpFile = join(TMP_DIR, `${id}.${ext}`);
    writeFileSync(tmpFile, buf);
    uploadToR2(key, tmpFile, contentType);

    const ok = await verifyCdn(finalUrl);
    if (!ok) throw new Error('CDN HEAD failed after upload');
    log(`OK ${id} -> ${finalUrl}`);
    uploaded++;
  } catch (e) {
    log(`FAIL ${id} (${oldUrl}): ${e.message}`);
    failed++;
  }
}

// Patch cards-base.csv
if (!dryRun && uploaded + skipped > 0) {
  const lines = readFileSync(join(root, 'cards-base.csv'), 'utf8').split(/\r?\n/);
  const header = lines[0];
  const out = [header];
  for (const card of cards) {
    const row = [
      card.external_id,
      card.name,
      card.description,
      card._newImage || card.image,
      card.rarity,
      card.type,
      card.subtype,
      card.abilities || '',
    ];
    out.push(row.map((v) => (String(v).includes(',') || String(v).includes('"') ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','));
  }
  writeFileSync(join(root, 'cards-base.csv'), out.join('\n') + '\n', 'utf8');
  log('Updated cards-base.csv');
}

// Write mapping file for DB patch
const mapPath = join(root, 'scripts', 'image-url-mapping.json');
writeFileSync(mapPath, JSON.stringify(Object.fromEntries(mapping), null, 2), 'utf8');
log(`Mapping written: ${mapPath} (${mapping.size} unique URLs)`);

if (updateDb && !dryRun) {
  const gameDir = join(root, '..', 'nexus-nemesis-game');
  const r = spawnSync(
    'railway',
    ['variables', '--service', 'nexus-nemesis-game', '--environment', 'production', '--json'],
    { encoding: 'utf8', shell: true, cwd: gameDir }
  );
  if (r.status !== 0) throw new Error('Railway vars failed');
  const vars = JSON.parse(r.stdout);
  const pool = new pg.Pool({
    connectionString: (vars.DATABASE_PUBLIC_URL || vars.DATABASE_URL || '').trim(),
    ssl: { rejectUnauthorized: false },
  });

  let totalUpdated = 0;
  for (const [oldUrl, newUrl] of mapping) {
    if (oldUrl === newUrl) continue;
    const res = await pool.query(
      `UPDATE nexus_cards SET image_url = $1 WHERE image_url = $2`,
      [newUrl, oldUrl]
    );
    totalUpdated += res.rowCount;
    if (res.rowCount > 0) log(`DB ${res.rowCount} rows: ${oldUrl.slice(-20)} -> ${newUrl.slice(-30)}`);
  }
  log(`DB total rows updated: ${totalUpdated}`);
  await pool.end();
}

console.log('\n=== Summary ===', { uploaded, skipped, failed, uniqueUrls: mapping.size, dryRun, updateDb });
process.exit(failed > 0 ? 1 : 0);