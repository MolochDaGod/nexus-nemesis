#!/usr/bin/env node
// Nexus Nemesis — Generate Season 1 tribe cards (default 100,000)
// Usage: node scripts/generate-cards.js
// Optional: TARGET_TOTAL=50000 node scripts/generate-cards.js

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const {
  TRIBES,
  RARITY_SUPPLY,
  SEASON1_MAX_SUPPLY,
  SEASON_TRIBE,
  rollTribe,
  rollTraits,
  rollBonusAbilities,
} = require('../server/lib/tribe-config');

const TARGET_TOTAL = parseInt(process.env.TARGET_TOTAL || String(SEASON1_MAX_SUPPLY), 10);
const CSV_PATH = path.resolve(__dirname, '..', 'cards-base.csv');
const OUT_JSON = path.resolve(__dirname, '..', 'output', `nexus_cards_${TARGET_TOTAL}.json`);
const OUT_SQL = path.resolve(__dirname, '..', 'output', `nexus_cards_${TARGET_TOTAL}.sql`);
const OUT_STATS = path.resolve(__dirname, '..', 'output', 'generation_stats.json');

// ── Load base cards ──────────────────────────────────────────────
const csvRaw = fs.readFileSync(CSV_PATH, 'utf-8');
const baseCards = parse(csvRaw, { columns: true, skip_empty_lines: true, trim: true });
console.log(`Loaded ${baseCards.length} base cards from CSV`);

// ── Group by rarity and calculate copies ─────────────────────────
const rarityGroups = {};
for (const card of baseCards) {
  const r = card.rarity;
  if (!rarityGroups[r]) rarityGroups[r] = [];
  rarityGroups[r].push(card);
}

// Calculate exact copies per card to hit TARGET_TOTAL
let totalPlanned = 0;
const copyMap = {}; // base_card_id -> copy count

for (const [rarity, cards] of Object.entries(rarityGroups)) {
  const copiesPerCard = RARITY_SUPPLY[rarity];
  if (!copiesPerCard) {
    console.warn(`WARNING: No supply config for rarity "${rarity}", defaulting to 1000`);
  }
  for (const card of cards) {
    const copies = copiesPerCard || 1000;
    copyMap[card.external_id] = copies;
    totalPlanned += copies;
  }
}

console.log(`Planned total: ${totalPlanned} cards`);

// Adjust to hit exactly TARGET_TOTAL by tweaking Common copies
if (totalPlanned !== TARGET_TOTAL) {
  const diff = TARGET_TOTAL - totalPlanned;
  const commonCards = rarityGroups['Common'] || [];
  if (commonCards.length > 0) {
    const adjustPerCard = Math.floor(diff / commonCards.length);
    const remainder = diff % commonCards.length;
    for (let i = 0; i < commonCards.length; i++) {
      const id = commonCards[i].external_id;
      copyMap[id] += adjustPerCard + (i < Math.abs(remainder) ? Math.sign(diff) : 0);
    }
    totalPlanned = Object.values(copyMap).reduce((a, b) => a + b, 0);
    console.log(`Adjusted to ${totalPlanned} cards (diff was ${diff})`);
  }
}

// ── Generate Season 1 tribe cards ────────────────────────────────
console.log(`Generating ${TARGET_TOTAL} Season 1 tribe cards...`);
const allCards = [];
let cardNumber = 1;
const editionCounters = {}; // base_card_id -> current edition number

// Track stats
const stats = {
  total: 0,
  byTribe: {},
  byRarity: {},
  byType: {},
  bySubtype: {},
  traits: { life: 0, fire: 0, foil: 0 },
  signatureCount: 0,
  bonusAbilityCount: 0,
};

for (const baseCard of baseCards) {
  const copies = copyMap[baseCard.external_id] || 0;
  editionCounters[baseCard.external_id] = 0;

  for (let i = 0; i < copies; i++) {
    editionCounters[baseCard.external_id]++;
    const edition = editionCounters[baseCard.external_id];

    // Roll tribe
    const tribe = rollTribe();
    const tribeConfig = TRIBES[tribe];

    // Roll traits & abilities
    const traits = rollTraits();
    const bonusAbilities = rollBonusAbilities();

    // Base stats (randomized within card type ranges)
    let attack = 0;
    let health = 0;
    let manaCost = 0;

    if (baseCard.type === 'Minion' || baseCard.type === 'Hero') {
      // Scale by rarity
      const rarityMultiplier = {
        'Common': 1, 'CommonHC': 1.2, 'Uncommon': 1.5, 'Uncommonhc': 1.5,
        'Rare': 2, 'Epic': 2.5, 'Legendary': 3, 'StarterM': 0.5,
      }[baseCard.rarity] || 1;

      attack = Math.max(1, Math.floor((1 + Math.random() * 3) * rarityMultiplier));
      health = Math.max(1, Math.floor((1 + Math.random() * 4) * rarityMultiplier));
      manaCost = Math.max(1, Math.floor(1 + Math.random() * 5 * (rarityMultiplier * 0.6)));
    } else if (baseCard.type === 'Spell') {
      manaCost = Math.max(1, Math.floor(2 + Math.random() * 6));
    } else if (baseCard.type === 'StarterM') {
      attack = 1;
      health = 1;
      manaCost = 1;
    }

    // Ethereal Signature bonuses
    const isSignature = tribe === 'Ethereal Signature';
    if (isSignature) {
      attack += 2;
      health += 2;
      manaCost = Math.max(0, manaCost - 1);
    }

    // Trait bonuses
    if (traits.life) health += 1;
    if (traits.fire) attack += 1;

    const card = {
      id: uuidv4(),
      card_number: cardNumber++,
      base_card_id: parseInt(baseCard.external_id),
      name: baseCard.name,
      description: baseCard.description || '',
      image_url: baseCard.image,
      rarity: baseCard.rarity,
      type: baseCard.type,
      subtype: baseCard.subtype,
      abilities: baseCard.abilities || '',
      tribe,
      tribe_bg: tribeConfig.background,
      tribe_border: tribeConfig.borderColor,
      attack,
      health,
      mana_cost: manaCost,
      traits,
      bonus_abilities: bonusAbilities,
      is_signature: isSignature,
      edition: `#${edition} of ${copies}`,
      season: SEASON_TRIBE,
      mint_status: 'unminted',
    };

    allCards.push(card);

    // Update stats
    stats.total++;
    stats.byTribe[tribe] = (stats.byTribe[tribe] || 0) + 1;
    stats.byRarity[baseCard.rarity] = (stats.byRarity[baseCard.rarity] || 0) + 1;
    stats.byType[baseCard.type] = (stats.byType[baseCard.type] || 0) + 1;
    stats.bySubtype[baseCard.subtype] = (stats.bySubtype[baseCard.subtype] || 0) + 1;
    if (traits.life) stats.traits.life++;
    if (traits.fire) stats.traits.fire++;
    if (traits.foil) stats.traits.foil++;
    if (isSignature) stats.signatureCount++;
    if (bonusAbilities.length > 0) stats.bonusAbilityCount++;
  }
}

console.log(`Generated ${allCards.length} cards`);

// ── Write output ─────────────────────────────────────────────────
const outDir = path.resolve(__dirname, '..', 'output');
fs.mkdirSync(outDir, { recursive: true });

// JSON output (chunked to avoid memory issues)
console.log('Writing JSON...');
const jsonStream = fs.createWriteStream(OUT_JSON);
jsonStream.write('[\n');
for (let i = 0; i < allCards.length; i++) {
  jsonStream.write(JSON.stringify(allCards[i]));
  if (i < allCards.length - 1) jsonStream.write(',\n');
}
jsonStream.write('\n]');
jsonStream.end();

// SQL output (batched INSERT)
console.log('Writing SQL...');
const sqlStream = fs.createWriteStream(OUT_SQL);
sqlStream.write(`-- Nexus Nemesis ${SEASON_TRIBE} — ${TARGET_TOTAL} tribe card INSERT\n`);
sqlStream.write('-- Auto-generated, do not edit\n\n');

const BATCH_SIZE = 500;
for (let i = 0; i < allCards.length; i += BATCH_SIZE) {
  const batch = allCards.slice(i, i + BATCH_SIZE);
  sqlStream.write(`INSERT INTO nexus_cards (id, card_number, base_card_id, name, description, image_url, rarity, type, subtype, abilities, tribe, tribe_bg, tribe_border, attack, health, mana_cost, traits, bonus_abilities, is_signature, edition, season, mint_status) VALUES\n`);

  const rows = batch.map(c => {
    const esc = (s) => (s || '').replace(/'/g, "''");
    const traitsJson = JSON.stringify(c.traits).replace(/'/g, "''");
    const bonusArr = c.bonus_abilities.length > 0
      ? `ARRAY[${c.bonus_abilities.map(a => `'${esc(a)}'`).join(',')}]`
      : `'{}'`;
    return `  ('${c.id}', ${c.card_number}, ${c.base_card_id}, '${esc(c.name)}', '${esc(c.description)}', '${esc(c.image_url)}', '${esc(c.rarity)}', '${esc(c.type)}', '${esc(c.subtype)}', '${esc(c.abilities)}', '${esc(c.tribe)}', '${esc(c.tribe_bg)}', '${esc(c.tribe_border)}', ${c.attack}, ${c.health}, ${c.mana_cost}, '${traitsJson}'::jsonb, ${bonusArr}, ${c.is_signature}, '${esc(c.edition)}', '${esc(c.season)}', '${esc(c.mint_status)}')`;
  });

  sqlStream.write(rows.join(',\n'));
  sqlStream.write(';\n\n');
}
sqlStream.end();

// Stats output
fs.writeFileSync(OUT_STATS, JSON.stringify(stats, null, 2));

console.log('\n=== GENERATION COMPLETE ===');
console.log(`Total cards: ${stats.total}`);
console.log('\nBy Tribe:');
for (const [t, n] of Object.entries(stats.byTribe).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${n} (${(n / stats.total * 100).toFixed(1)}%)`);
}
console.log('\nBy Rarity:');
for (const [r, n] of Object.entries(stats.byRarity).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${r}: ${n}`);
}
console.log(`\nSignature cards: ${stats.signatureCount}`);
console.log(`Cards with bonus abilities: ${stats.bonusAbilityCount}`);
console.log(`Trait rolls — Life: ${stats.traits.life}, Fire: ${stats.traits.fire}, Foil: ${stats.traits.foil}`);
console.log(`\nOutput:`);
console.log(`  JSON: ${OUT_JSON}`);
console.log(`  SQL:  ${OUT_SQL}`);
console.log(`  Stats: ${OUT_STATS}`);
