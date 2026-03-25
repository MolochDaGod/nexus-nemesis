#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { generateLibraryPrices } = require('../server/lib/library-pricing');

const csv = fs.readFileSync(path.resolve(__dirname, '..', 'cards-base.csv'), 'utf-8');
const cards = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

const prices = generateLibraryPrices(cards);
const entries = Object.entries(prices);
const vals = entries.map(([, p]) => p.price);

console.log(`Cards: ${entries.length}`);
console.log(`Range: ${Math.min(...vals)} to ${Math.max(...vals)} GBUX`);

const dist = {};
vals.forEach(v => {
  const t = v <= 5 ? 'common' : v <= 12 ? 'uncommon' : v <= 22 ? 'rare' : v <= 35 ? 'epic' : 'legendary';
  dist[t] = (dist[t] || 0) + 1;
});
console.log('Distribution:', JSON.stringify(dist, null, 2));

console.log('\nTop 10 (most expensive):');
entries.sort((a, b) => b[1].price - a[1].price).slice(0, 10).forEach(([id, p]) => {
  const c = cards.find(x => x.external_id === id);
  console.log(`  #${id.padStart(3)} ${c.name.padEnd(25)} ${String(p.price).padStart(3)} GBUX  ${c.rarity.padEnd(12)} ${c.type}`);
});

console.log('\nBottom 10 (cheapest):');
entries.sort((a, b) => a[1].price - b[1].price).slice(0, 10).forEach(([id, p]) => {
  const c = cards.find(x => x.external_id === id);
  console.log(`  #${id.padStart(3)} ${c.name.padEnd(25)} ${String(p.price).padStart(3)} GBUX  ${c.rarity.padEnd(12)} ${c.type}`);
});
