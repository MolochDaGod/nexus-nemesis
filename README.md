# Nexus Nemesis — Season 0

100,000 compressed NFT (cNFT) trading card system for Grudge Studio's Nexus Nemesis TCG on Solana.

## Architecture

- **API Server**: Express.js deployed on Vercel serverless
- **Database**: PostgreSQL (Grudge backend)
- **Blockchain**: Solana cNFTs via Crossmint API
- **Currency**: GBUX (Solana SPL token)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/nexus/stats` | Collection statistics (tribe/rarity/mint distribution) |
| `GET` | `/api/nexus/cards/:grudgeId` | All cards owned by a Grudge ID |
| `GET` | `/api/nexus/card/:uuid` | Single card details with mint proof |
| `POST` | `/api/nexus/pack/buy` | Buy & open a card pack |
| `POST` | `/api/nexus/webhook` | Crossmint webhook receiver (HMAC-SHA256 verified) |

## Card Supply (Season 0)

- **Total**: 100,000 cards from 102 base designs
- **Rarities**: Common, CommonHC, Uncommon, Uncommonhc, Rare, Epic, Legendary, StarterM

### Tribe Distribution

| Tribe | Probability | Color | Effect |
|-------|------------|-------|--------|
| Iron Will | 40% | Silver | +1 HP at turn start if multiple on field |
| Tribal War | 35% | Orange | Spawns 1/1 Taunt minion on play |
| Fabled | 15% | Purple | Reduces mana cost of other Fabled by 1 |
| Blood For Conquest | 10% | Red | +1 Attack to existing Red minions on summon |
| Ethereal Signature | 2% | Gold | -1 mana, +2/+2, one-of-one |

### Pack Types

| Pack | Cards | Cost (GBUX) |
|------|-------|-------------|
| Starter | 5 | 10 |
| Premium | 10 | 50 |
| Legendary | 3 | 100 |

## Scripts

```bash
# Generate 100K cards (outputs JSON + SQL to output/)
npm run generate

# Batch mint cNFTs via Crossmint API
npm run mint

# Start local dev server
npm run dev

# Start production server
npm run start
```

## Environment Variables

Copy `.env.example` to `.env` and fill in values. Required:

- `CROSSMINT_API_KEY` — Server-side Crossmint key
- `CROSSMINT_CLIENT_KEY` — Client-side Crossmint key
- `CROSSMINT_PROJECT_ID` — Crossmint project ID
- `CROSSMINT_COLLECTION_ID` — Nexus Nemesis collection ID
- `CROSSMINT_WEBHOOK_SECRET` — Webhook signing secret (`whsec_...`)
- `DATABASE_URL` — PostgreSQL connection string
- `ADMIN_WALLET_ADDRESS` — Solana public address for admin wallet
- `GBUX_MINT_ADDRESS` — GBUX SPL token mint address
- `DISCORD_WEBHOOK_CARDS` — Discord webhook for card mint notifications
- `DISCORD_WEBHOOK_CARDOPEN` — Discord webhook for pack open notifications

## Database Setup

Run `scripts/create-tables.sql` against your PostgreSQL instance to create:
- `nexus_cards` — 100K card inventory
- `nexus_packs` — Pack purchase log
- `nexus_mint_log` — Crossmint minting audit trail

Then import `output/nexus_cards_100k.sql` to seed the card supply.

## Deployment

Deployed on Vercel as a serverless Express API. Environment variables are managed via Vercel CLI.

```bash
vercel --prod --yes
```

## Project Structure

```
grudge-tcg/
├── api/index.js                 # Vercel serverless entry point
├── server/
│   ├── index.js                 # Express app (exported for Vercel)
│   ├── routes/nexus.js          # Card, pack, webhook API routes
│   └── lib/tribe-config.js      # Tribe definitions & roll functions
├── scripts/
│   ├── generate-cards.js        # 100K card generator
│   ├── mint-batch.js            # Crossmint batch minter
│   └── create-tables.sql        # PostgreSQL schema
├── output/                      # Generated card data (gitignored)
├── cards-base.csv               # 102 base card definitions
├── vercel.json                  # Vercel deployment config
├── package.json
├── .env.example
└── .gitignore
```

---

**Grudge Studio** — [grudgeplatform.com](https://grudgeplatform.com)
