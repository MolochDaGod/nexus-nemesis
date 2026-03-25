// Nexus Nemesis — Library Pricing (Power Ranked)
// All prices in GBUX. Range: 1–51 GBUX.
// $1 USD ≈ price of 1 GBUX on-chain.
// Pricing formula: rarity base + ability power score + keyword bonuses.

const RARITY_BASE_PRICE = {
  'StarterM':    1,
  'Common':      2,
  'CommonHC':    5,
  'Uncommon':    7,
  'Uncommonhc': 10,
  'Rare':       15,
  'Epic':       25,
  'Legendary':  40,
};

// Keyword value adds (GBUX)
const KEYWORD_VALUE = {
  'taunt':         1,
  'stealth':       2,
  'haste':         2,
  'double strike': 3,
  'gold shield':   4,
  'poison touch':  2,
};

// Ability effect scoring
function scoreAbility(abilities) {
  if (!abilities) return 0;
  const a = abilities.toLowerCase();
  let score = 0;

  // Direct damage
  const dmgMatch = a.match(/deal (\d+) damage/);
  if (dmgMatch) score += parseInt(dmgMatch[1]);

  // AoE (all enemies)
  if (a.includes('all enemy')) score += 3;
  if (a.includes('randomly split')) score += 1;

  // Healing
  const healMatch = a.match(/restore (\d+) health/);
  if (healMatch) score += Math.floor(parseInt(healMatch[1]) * 0.8);

  // Summon tokens
  const summonMatch = a.match(/summon.*?(\d+)\/(\d+)/);
  if (summonMatch) score += parseInt(summonMatch[1]) + parseInt(summonMatch[2]);
  if (a.includes('summon two')) score += 2;

  // Buff allies
  if (a.includes('+1 attack')) score += 1;
  if (a.includes('+1 health')) score += 1;
  if (a.includes('+1/+1')) score += 2;
  if (a.includes('+2 attack')) score += 2;
  if (a.includes('+2 health')) score += 2;

  // Card draw
  if (a.includes('draw a card') || a.includes('draw a spell')) score += 2;
  if (a.includes('draw 2')) score += 3;

  // Control effects
  if (a.includes('take control')) score += 5;
  if (a.includes('destroy an enemy')) score += 4;
  if (a.includes('return a friendly minion')) score += 1;

  // Recurring effects (start/end of turn)
  if (a.includes('start of your turn') || a.includes('end of your turn')) score += 2;

  // Keywords embedded in abilities text
  for (const [kw, val] of Object.entries(KEYWORD_VALUE)) {
    if (a.includes(kw)) score += val;
  }

  return score;
}

// Hero type bonus
function heroBonus(type, rarity) {
  if (type === 'Hero') return 5;
  return 0;
}

/**
 * Calculate library GBUX price for a base card.
 * @param {Object} card - { rarity, type, abilities }
 * @returns {number} GBUX price (1–51)
 */
function calculateLibraryPrice(card) {
  // StarterM type cards are always 1 GBUX regardless of CSV rarity
  if (card.type === 'StarterM') return 1;

  const base = RARITY_BASE_PRICE[card.rarity] || 2;
  const abilityScore = scoreAbility(card.abilities);
  const hero = heroBonus(card.type, card.rarity);

  // Raw price
  let price = base + Math.floor(abilityScore * 1.2) + hero;

  // Clamp to 1–51
  return Math.max(1, Math.min(51, price));
}

// Pre-computed prices for all 102 base cards (keyed by external_id string)
// This gets populated on first require by generate()
let LIBRARY_PRICES = null;

/**
 * Generate library prices from base card CSV data.
 * @param {Array} baseCards - parsed CSV rows with { external_id, rarity, type, abilities }
 * @returns {Object} { [external_id]: { price, tier } }
 */
function generateLibraryPrices(baseCards) {
  const prices = {};
  for (const card of baseCards) {
    const price = calculateLibraryPrice(card);
    let tier;
    if (price <= 5) tier = 'common';
    else if (price <= 12) tier = 'uncommon';
    else if (price <= 22) tier = 'rare';
    else if (price <= 35) tier = 'epic';
    else tier = 'legendary';

    prices[card.external_id] = { price, tier };
  }
  LIBRARY_PRICES = prices;
  return prices;
}

module.exports = {
  RARITY_BASE_PRICE,
  KEYWORD_VALUE,
  scoreAbility,
  calculateLibraryPrice,
  generateLibraryPrices,
  getLibraryPrices: () => LIBRARY_PRICES,
};
