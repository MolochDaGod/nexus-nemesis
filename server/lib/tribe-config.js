// Nexus Nemesis — Tribe Configuration
// Tribes are assigned at mint via weighted random roll, independent of base card subtype.

const TRIBES = {
  'Iron Will': {
    key: 'iron_will',
    background: 'https://i.imgur.com/QPQXtX5.png',
    borderColor: '#C0C0C0',
    badgeColor: '#C0C0C0',
    probability: 0.40,
    upgrade: 'Each Iron Will minion gains +1 HP at turn start if multiple on field',
    spell: 'Plays 1/1 Grudge',
    emblem: 'https://i.imgur.com/SRoq392.png',
  },
  'Tribal War': {
    key: 'tribal_war',
    background: 'https://i.imgur.com/yPR4E8e.png',
    borderColor: '#FFA500',
    badgeColor: '#FFA500',
    probability: 0.35,
    upgrade: 'Spawns 1/1 Taunt minion on play',
    spell: 'Heal player for 1 Health',
    emblem: 'https://i.imgur.com/SRoq392.png',
  },
  'Fabled': {
    key: 'fabled',
    background: 'https://i.imgur.com/G0hXKXn.png',
    borderColor: '#800080',
    badgeColor: '#800080',
    probability: 0.15,
    upgrade: 'Each Fabled reduces mana cost of other Fabled cards by 1 (min 0)',
    spell: 'Give all Grudges +0/+1',
    emblem: 'https://i.imgur.com/SRoq392.png',
  },
  'Blood For Conquest': {
    key: 'blood_for_conquest',
    background: 'https://i.imgur.com/FqkZqZb.png',
    borderColor: '#FF0000',
    badgeColor: '#FF0000',
    probability: 0.10,
    upgrade: '+1 Attack to existing Red minions on summon (this turn only)',
    spell: 'Give all Grudges +1/+0',
    emblem: 'https://i.imgur.com/SRoq392.png',
  },
  'Ethereal Signature': {
    key: 'ethereal_signature',
    background: 'https://i.imgur.com/o0d99bB.png',
    borderColor: '#FFD700',
    badgeColor: '#00FF00',
    probability: 0.02,
    upgrade: 'One-of-one, -1 mana cost, +2/+2, max 1 on field, max 3 in deck',
    spell: 'Half cost of normal spells',
    emblem: 'https://i.imgur.com/SRoq392.png',
    middleEmblem: 'https://i.imgur.com/48to9zn.png',
  },
};

// Pack type tribe probability overrides
const PACK_TRIBE_WEIGHTS = {
  starter: {
    'Iron Will': 0.40,
    'Tribal War': 0.35,
    'Fabled': 0.15,
    'Blood For Conquest': 0.10,
    'Ethereal Signature': 0.02,
  },
  premium: {
    'Iron Will': 0.30,
    'Tribal War': 0.30,
    'Fabled': 0.20,
    'Blood For Conquest': 0.15,
    'Ethereal Signature': 0.05,
  },
  legendary: {
    'Iron Will': 0.20,
    'Tribal War': 0.20,
    'Fabled': 0.20,
    'Blood For Conquest': 0.20,
    'Ethereal Signature': 0.20,
  },
};

const PACK_CONFIG = {
  starter:   { cards: 5,  cost: 10,  traitChance: 0.05, abilityChance: 0.05 },
  premium:   { cards: 10, cost: 50,  traitChance: 0.10, abilityChance: 0.05 },
  legendary: { cards: 3,  cost: 100, traitChance: 0.20, abilityChance: 0.05 },
};

// Rarity -> copies per base card (tuned to hit 100K total)
const RARITY_SUPPLY = {
  'Common':      1400,
  'CommonHC':    1200,
  'Uncommon':    600,
  'Uncommonhc':  600,
  'Rare':        400,
  'Epic':        250,
  'Legendary':   100,
  'StarterM':    7350,
};

const BONUS_ABILITIES = ['Haste', 'Stealth', 'Ally Boost', 'Heal on Play', 'Gold Shield', 'Double Strike'];
const RARE_TRAITS = ['life', 'fire', 'foil'];

/**
 * Weighted random tribe selection
 * @param {Object} weights - tribe name -> probability
 * @returns {string} selected tribe name
 */
function rollTribe(weights) {
  // Default: extract probability numbers from TRIBES config objects
  const probs = weights
    || Object.fromEntries(Object.entries(TRIBES).map(([k, v]) => [k, v.probability]));
  const entries = Object.entries(probs);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [name, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

/**
 * Roll traits for a card (life, fire, foil)
 * @param {number} chance - probability per trait (0-1)
 * @returns {Object} { life: bool, fire: bool, foil: bool }
 */
function rollTraits(chance = 0.05) {
  return {
    life: Math.random() < chance,
    fire: Math.random() < chance,
    foil: Math.random() < chance,
  };
}

/**
 * Roll bonus abilities (5% each)
 * @param {number} chance - probability per ability
 * @returns {string[]} array of bonus ability names
 */
function rollBonusAbilities(chance = 0.05) {
  return BONUS_ABILITIES.filter(() => Math.random() < chance);
}

module.exports = {
  TRIBES,
  PACK_TRIBE_WEIGHTS,
  PACK_CONFIG,
  RARITY_SUPPLY,
  BONUS_ABILITIES,
  RARE_TRAITS,
  rollTribe,
  rollTraits,
  rollBonusAbilities,
};
