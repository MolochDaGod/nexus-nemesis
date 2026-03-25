-- Nexus Nemesis Season 0 — 100K Card Production Schema
-- Connects to Grudge backend PostgreSQL

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- The 100K pre-generated card pool
CREATE TABLE IF NOT EXISTS nexus_cards (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  card_number     INTEGER UNIQUE NOT NULL,          -- 1-100000
  base_card_id    INTEGER NOT NULL,                  -- references cards-base.csv external_id
  name            TEXT NOT NULL,
  description     TEXT,
  image_url       TEXT NOT NULL,
  rarity          TEXT NOT NULL,                     -- Common/Uncommon/Rare/Epic/Legendary/CommonHC/Uncommonhc/StarterM
  type            TEXT NOT NULL,                     -- Minion/Spell/Hero/StarterM
  subtype         TEXT NOT NULL,                     -- Crusade/Legion/Elf/Ship/Spell/Lore/Celestial/StarterM
  abilities       TEXT,
  tribe           TEXT NOT NULL,                     -- Iron Will/Blood For Conquest/Fabled/Tribal War/Ethereal Signature
  tribe_bg        TEXT NOT NULL,                     -- card background image URL
  tribe_border    TEXT NOT NULL,                     -- hex border color
  attack          INTEGER NOT NULL DEFAULT 0,
  health          INTEGER NOT NULL DEFAULT 0,
  mana_cost       INTEGER NOT NULL DEFAULT 0,
  traits          JSONB NOT NULL DEFAULT '{}',       -- { life: bool, fire: bool, foil: bool }
  bonus_abilities TEXT[] NOT NULL DEFAULT '{}',      -- extra Haste/Stealth/Ally Boost from roll
  is_signature    BOOLEAN NOT NULL DEFAULT FALSE,
  edition         TEXT NOT NULL,                     -- e.g. "#342 of 1400"
  season          TEXT NOT NULL DEFAULT 'Season 0',
  mint_status     TEXT NOT NULL DEFAULT 'unminted'
    CHECK (mint_status IN ('unminted', 'minting', 'minted', 'assigned', 'pending')),
  crossmint_id    TEXT,                              -- cNFT action ID from Crossmint
  owner_grudge_id TEXT,                              -- NULL until assigned via pack buy
  owner_wallet    TEXT,                              -- Solana wallet or email
  minted_at       TIMESTAMPTZ,
  assigned_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_nexus_cards_mint_status ON nexus_cards(mint_status);
CREATE INDEX IF NOT EXISTS idx_nexus_cards_owner ON nexus_cards(owner_grudge_id) WHERE owner_grudge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nexus_cards_tribe ON nexus_cards(tribe);
CREATE INDEX IF NOT EXISTS idx_nexus_cards_rarity ON nexus_cards(rarity);
CREATE INDEX IF NOT EXISTS idx_nexus_cards_base ON nexus_cards(base_card_id);
CREATE INDEX IF NOT EXISTS idx_nexus_cards_crossmint ON nexus_cards(crossmint_id) WHERE crossmint_id IS NOT NULL;

-- Pack purchase records
CREATE TABLE IF NOT EXISTS nexus_packs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  grudge_id   TEXT NOT NULL,
  pack_type   TEXT NOT NULL CHECK (pack_type IN ('starter', 'premium', 'legendary')),
  gbux_cost   INTEGER NOT NULL,
  cards       UUID[] NOT NULL,        -- array of nexus_cards.id
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_packs_grudge ON nexus_packs(grudge_id);

-- Crossmint mint transaction log
CREATE TABLE IF NOT EXISTS nexus_mint_log (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  card_id              UUID UNIQUE NOT NULL REFERENCES nexus_cards(id),  -- UNIQUE: one mint log per card
  crossmint_action_id  TEXT,
  crossmint_status     TEXT NOT NULL DEFAULT 'pending'
    CHECK (crossmint_status IN ('pending', 'success', 'failed')),
  recipient_wallet     TEXT,                          -- buyer's wallet or email
  tx_hash              TEXT,                          -- on-chain transaction hash
  error_message        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ                    -- set when success or failed
);

CREATE INDEX IF NOT EXISTS idx_nexus_mint_log_card ON nexus_mint_log(card_id);
CREATE INDEX IF NOT EXISTS idx_nexus_mint_log_status ON nexus_mint_log(crossmint_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nexus_mint_log_action ON nexus_mint_log(crossmint_action_id) WHERE crossmint_action_id IS NOT NULL;

-- Library purchase records (fixed-price base card sales, no tribe roll)
CREATE TABLE IF NOT EXISTS nexus_library_purchases (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  grudge_id       TEXT NOT NULL,
  base_card_id    INTEGER NOT NULL,                  -- references cards-base.csv external_id
  card_id         UUID NOT NULL REFERENCES nexus_cards(id),
  gbux_price      INTEGER NOT NULL,                  -- price paid in GBUX
  purchased_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nexus_library_grudge ON nexus_library_purchases(grudge_id);
CREATE INDEX IF NOT EXISTS idx_nexus_library_base ON nexus_library_purchases(base_card_id);

-- Migration helper: run these if tables already exist from old schema
-- ALTER TABLE nexus_cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- ALTER TABLE nexus_cards DROP CONSTRAINT IF EXISTS nexus_cards_mint_status_check;
-- ALTER TABLE nexus_cards ADD CONSTRAINT nexus_cards_mint_status_check CHECK (mint_status IN ('unminted', 'minting', 'minted', 'assigned', 'pending'));
-- ALTER TABLE nexus_mint_log ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
-- ALTER TABLE nexus_mint_log DROP COLUMN IF EXISTS admin_wallet;
-- ALTER TABLE nexus_mint_log DROP COLUMN IF EXISTS updated_at;
-- ALTER TABLE nexus_mint_log ADD CONSTRAINT nexus_mint_log_card_id_key UNIQUE (card_id);
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_nexus_mint_log_action ON nexus_mint_log(crossmint_action_id) WHERE crossmint_action_id IS NOT NULL;
