// Nexus Nemesis — API Server
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const createNexusRouter = require('./routes/nexus');

const app = express();
const PORT = process.env.PORT || 3100;

// DB pool — connects to Grudge backend
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

// Raw body capture for webhook signature verification (must be before express.json)
app.use('/api/nexus/webhook', express.raw({ type: 'application/json' }));

// Middleware
app.use(express.json());

// CORS (allow game client & Vercel preview domains)
const ALLOWED_ORIGINS = [
  'https://grudgeplatform.com',
  'https://grudgewarlords.com',
  'https://grudge-warlords-game.vercel.app',
  /\.vercel\.app$/,
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = ALLOWED_ORIGINS.some(o =>
    o instanceof RegExp ? o.test(origin) : o === origin
  );
  res.header('Access-Control-Allow-Origin', allowed ? origin : '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Favicon (prevent 404 noise)
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Root — API info
app.get('/', (req, res) => {
  res.json({
    service: 'Nexus Nemesis',
    season: 'Season 0',
    supply: 100000,
    docs: '/api/health',
    endpoints: [
      'GET  /api/health',
      'GET  /api/nexus/stats',
      'GET  /api/nexus/cards/:grudgeId',
      'GET  /api/nexus/card/:uuid',
      'POST /api/nexus/pack/buy',
      'POST /api/nexus/webhook',
    ],
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'nexus-nemesis', season: 'Season 0' });
});

// Nexus card/pack routes
app.use('/api/nexus', createNexusRouter(pool));

// Only listen when running directly (not on Vercel)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Nexus Nemesis API running on port ${PORT}`);
    console.log(`  Health: http://localhost:${PORT}/api/health`);
    console.log(`  Stats:  http://localhost:${PORT}/api/nexus/stats`);
    console.log(`  Cards:  http://localhost:${PORT}/api/nexus/cards/:grudgeId`);
  });
}

// Export for Vercel serverless
module.exports = app;
