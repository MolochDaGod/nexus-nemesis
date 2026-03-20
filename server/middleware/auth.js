// Grudge Auth Middleware — JWT verification for Nexus Nemesis API
// Tokens issued by Grudge Auth Gateway, verified locally with shared secret.
//
// Protected routes require: Authorization: Bearer <token>
// On success, sets req.grudgeUser with { userId, grudgeId, username, role, wallet }

const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

const JWT_SECRET = process.env.GRUDGE_JWT_SECRET;
const AUTH_GATEWAY_URL = process.env.GRUDGE_AUTH_URL || 'https://auth-gateway-otb8qmmyd-grudgenexus.vercel.app';

// In-memory token cache (verified token → user data, TTL 5 min)
// Prevents re-verification on rapid successive requests
const tokenCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (now - entry.ts > CACHE_TTL) tokenCache.delete(key);
  }
}
// Clean every 2 minutes
setInterval(cleanCache, 2 * 60 * 1000).unref();

/**
 * Extract Bearer token from Authorization header.
 */
function extractToken(req) {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/**
 * Verify a Grudge Auth token.
 * Strategy 1: Local JWT verification (fast, no network hop — requires GRUDGE_JWT_SECRET)
 * Strategy 2: Fallback to Auth Gateway /api/verify (for when JWT secret isn't shared)
 *
 * @returns {{ userId, grudgeId, username, role, wallet }} or null
 */
async function verifyToken(token) {
  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.user;
  }

  let user = null;

  // Strategy 1: Local JWT verification (preferred — no network hop)
  if (JWT_SECRET) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      user = {
        userId: decoded.userId || decoded.id || decoded.sub,
        grudgeId: decoded.grudgeId || decoded.id,
        username: decoded.username || decoded.name || 'Player',
        role: decoded.role || 'user',
        wallet: decoded.walletAddress || decoded.wallet || null,
      };
    } catch (err) {
      // JWT expired or invalid — don't cache, don't fallback
      if (err.name === 'TokenExpiredError') return null;
      // For other JWT errors, try gateway fallback
    }
  }

  // Strategy 2: Gateway fallback (when no JWT_SECRET or JWT verify failed)
  if (!user) {
    try {
      const res = await fetch(`${AUTH_GATEWAY_URL}/api/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(3000), // 3s timeout
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && (data.user || data.userId)) {
          const u = data.user || data;
          user = {
            userId: u.userId || u.id,
            grudgeId: u.grudgeId || u.id,
            username: u.username || 'Player',
            role: u.role || 'user',
            wallet: u.walletAddress || u.wallet || null,
          };
        }
      }
    } catch {
      // Gateway unreachable — auth fails
    }
  }

  // Cache successful verification
  if (user) {
    tokenCache.set(token, { user, ts: Date.now() });
  }

  return user;
}

/**
 * Express middleware: require authentication.
 * Sets req.grudgeUser on success, returns 401 on failure.
 */
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Send Authorization: Bearer <token>' });
  }

  verifyToken(token)
    .then(user => {
      if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      req.grudgeUser = user;
      next();
    })
    .catch(err => {
      console.error('Auth middleware error:', err);
      res.status(500).json({ error: 'Authentication service error' });
    });
}

/**
 * Express middleware: optional authentication.
 * Sets req.grudgeUser if token is present and valid, but doesn't block.
 */
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();

  verifyToken(token)
    .then(user => {
      if (user) req.grudgeUser = user;
      next();
    })
    .catch(() => next());
}

module.exports = { requireAuth, optionalAuth, verifyToken };
