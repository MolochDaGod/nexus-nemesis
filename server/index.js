// Nexus Nemesis — API Server
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const createNexusRouter = require('./routes/nexus');
const { requireAuth, optionalAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3100;
const IS_SERVERLESS = process.env.VERCEL === '1';

// ── DB Pool ─────────────────────────────────────────────────────────
// Serverless (Vercel): 1-3 connections per cold start, short timeouts
// VPS/local: 10-20 connections, longer idle timeout
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: IS_SERVERLESS ? 2 : 15,
  idleTimeoutMillis: IS_SERVERLESS ? 10000 : 30000,
  connectionTimeoutMillis: IS_SERVERLESS ? 3000 : 5000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

// ── Raw body for webhook ───────────────────────────────────────────
app.use('/api/nexus/webhook', express.raw({ type: 'application/json' }));

// ── Body parser ────────────────────────────────────────────────────
app.use(express.json());

// ── CORS (strict — reject unknown origins) ────────────────────────
const ALLOWED_ORIGINS = [
  'https://grudgeplatform.com',
  'https://www.grudgeplatform.com',
  'https://grudgeplatform.io',
  'https://grudgewarlords.com',
  'https://grudge-warlords-game.vercel.app',
  'https://grudge-studio.com',
  'https://nexus.grudge-studio.com',
  'https://dash.grudge-studio.com',
];
// Also allow any *.vercel.app preview deploy + localhost for dev
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+-grudgenexus\.vercel\.app$/,
  /^https:\/\/nexus-nemesis[a-z0-9-]*\.vercel\.app$/,
  /^http:\/\/localhost:\d+$/,
];

function isOriginAllowed(origin) {
  if (!origin) return false; // Server-to-server (no origin header) — allowed by default
  return ALLOWED_ORIGINS.includes(origin)
    || ALLOWED_ORIGIN_PATTERNS.some(p => p.test(origin));
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (!origin) {
    // No origin = server-to-server or same-origin — allow
    next();
    return;
  }

  if (isOriginAllowed(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  } else {
    // Unknown origin — reject
    res.status(403).json({ error: 'Origin not allowed' });
  }
});

// ── Public routes (no auth) ───────────────────────────────────────
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/', (req, res) => {
  res.json({
    service: 'Nexus Nemesis',
    season: 'Season 0',
    supply: 100000,
    auth: 'Bearer token required for protected endpoints',
    endpoints: {
      public: [
        'GET  /api/health',
        'GET  /api/nexus/stats',
        'GET  /api/nexus/card/:uuid',
        'POST /api/nexus/webhook',
      ],
      protected: [
        'GET  /api/nexus/cards/:grudgeId  (auth required)',
        'POST /api/nexus/pack/buy         (auth required)',
      ],
    },
  });
});

app.get('/api/health', async (req, res) => {
  // Include DB connectivity check
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch { /* db down */ }
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'nexus-nemesis',
    season: 'Season 0',
    db: dbOk ? 'connected' : 'unreachable',
    env: IS_SERVERLESS ? 'serverless' : 'vps',
  });
});

// ── Nexus routes (auth applied per-route inside) ───────────────
app.use('/api/nexus', createNexusRouter(pool, { requireAuth, optionalAuth }));

// ── Start (VPS only) ───────────────────────────────────────────
if (!IS_SERVERLESS) {
  app.listen(PORT, () => {
    console.log(`Nexus Nemesis API running on port ${PORT}`);
    console.log(`  Env:    ${IS_SERVERLESS ? 'serverless' : 'vps'}`);
    console.log(`  DB max: ${IS_SERVERLESS ? 2 : 15} connections`);
    console.log(`  Health: http://localhost:${PORT}/api/health`);
  });
}

module.exports = app;
