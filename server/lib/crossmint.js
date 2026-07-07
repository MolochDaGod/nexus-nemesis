// Nexus Nemesis — Crossmint cNFT Minting (On-Demand)
// Idempotent minting: card UUID = mint key, prevents double-mints.
// Mints directly to the buyer's wallet (or email for custodial).

const fetch = require('node-fetch');

const CROSSMINT_API = 'https://www.crossmint.com/api/2022-06-09';

/**
 * Build the recipient string for Crossmint.
 * Supports: Solana wallet address, email (custodial), or Grudge ID (email fallback).
 *
 * @param {Object} opts
 * @param {string} [opts.wallet]  - Solana wallet address
 * @param {string} [opts.email]   - Email (creates custodial wallet)
 * @returns {string} Crossmint recipient locator
 */
function buildRecipient({ wallet, email }) {
  if (wallet) return `solana:${wallet}`;
  if (email) return `email:${email}:solana`;
  throw new Error('Either wallet or email is required for minting');
}

/**
 * Build NFT metadata from a card DB row.
 * Overrides the Crossmint template with card-specific data.
 *
 * @param {Object} card - nexus_cards DB row
 * @returns {Object} Crossmint metadata object
 */
function buildCardMetadata(card) {
  return {
    name: `${card.name} ${card.edition}`,
    image: card.image_url,
    description: card.description || `${card.name} — ${card.tribe} | ${card.rarity}`,
    attributes: [
      { trait_type: 'UUID', value: card.id },
      { trait_type: 'Card Number', value: String(card.card_number) },
      { trait_type: 'Tribe', value: card.tribe },
      { trait_type: 'Rarity', value: card.rarity },
      { trait_type: 'Type', value: card.type },
      { trait_type: 'SubType', value: card.subtype },
      { trait_type: 'Attack', value: String(card.attack) },
      { trait_type: 'Health', value: String(card.health) },
      { trait_type: 'Mana Cost', value: String(card.mana_cost) },
      { trait_type: 'Abilities', value: card.abilities || 'None' },
      { trait_type: 'Season', value: card.season },
      { trait_type: 'Edition', value: card.edition },
      { trait_type: 'Signature', value: card.is_signature ? 'Yes' : 'No' },
      ...(card.traits?.life ? [{ trait_type: 'Trait: Life', value: '+1 Health' }] : []),
      ...(card.traits?.fire ? [{ trait_type: 'Trait: Fire', value: '+1 Attack' }] : []),
      ...(card.traits?.foil ? [{ trait_type: 'Trait: Foil', value: 'Holographic' }] : []),
      ...(card.bonus_abilities || []).map(a => ({ trait_type: 'Bonus', value: a })),
    ],
  };
}

/**
 * Mint a single card as a cNFT via Crossmint (idempotent).
 * Uses PUT /collections/{id}/nfts/{cardUUID} — calling twice with
 * the same UUID returns the existing mint instead of a duplicate.
 *
 * @param {Object} card      - nexus_cards DB row
 * @param {Object} recipient - { wallet?: string, email?: string }
 * @returns {Promise<{ actionId: string, alreadyMinted: boolean }>}
 */
function trimEnv(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : v;
}

async function mintCardToRecipient(card, recipient) {
  const collectionId = trimEnv('CROSSMINT_COLLECTION_ID');
  const apiKey = trimEnv('CROSSMINT_API_KEY') || trimEnv('CROSSMINT_SERVER_API_KEY');

  if (!collectionId || !apiKey) {
    throw new Error('CROSSMINT_COLLECTION_ID and CROSSMINT_API_KEY required');
  }

  const body = {
    recipient: buildRecipient(recipient),
    metadata: buildCardMetadata(card),
    compressed: true,
    reuploadLinkedFiles: true,
  };

  // Idempotent mint — card UUID is the unique key
  const url = `${CROSSMINT_API}/collections/${collectionId}/nfts/${card.id}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    // 409 = already minted (idempotent hit — not an error)
    if (res.status === 409) {
      return { actionId: data.actionId || card.id, alreadyMinted: true };
    }
    throw new Error(`Crossmint ${res.status}: ${JSON.stringify(data)}`);
  }

  return { actionId: data.actionId || data.id, alreadyMinted: false };
}

module.exports = {
  CROSSMINT_API,
  buildRecipient,
  buildCardMetadata,
  mintCardToRecipient,
};
