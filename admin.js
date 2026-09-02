'use strict';
/**
 * The management API behind the dashboard.
 *
 * This is the one part of the relay that can read and write subscription credentials, so it is
 * mounted on the dashboard port only (server.js enforces that) and every route except login
 * requires a session cookie.
 *
 * Sessions are held in memory. Restarting logs everyone out, which is the right trade for a service
 * with no user database: there is nothing to leak on disk and nothing to invalidate.
 */
const crypto = require('crypto');
const { PORT_MIN, PORT_MAX } = require('./config');

const COOKIE = 'relay_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;

// Login throttling. Not a serious defence against a determined attacker, but it turns an
// overnight brute-force on a LAN into something that will not finish.
const LOCK_AFTER = 8;
const LOCK_MS = 5 * 60 * 1000;

const sessions = new Map();      // token -> expiry
const attempts = new Map();      // ip -> { n, until }

function log(msg) { try { console.log('[admin] ' + msg); } catch (e) {} }

// ---- sessions --------------------------------------------------------------------------------

function newSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_MS);
  sweep();
  return token;
}

function validSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function sweep() {
  const now = Date.now();
  for (const [t, exp] of Array.from(sessions.entries())) if (exp < now) sessions.delete(t);
}

function cookieFrom(req) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((s) => s.trim()).find((s) => s.indexOf(COOKIE + '=') === 0);
  return hit ? hit.slice(COOKIE.length + 1) : null;
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function locked(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (a.until && a.until > Date.now()) return true;
  if (a.until && a.until <= Date.now()) { attempts.delete(ip); return false; }
  return false;
}

function noteFailure(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= LOCK_AFTER) { a.until = Date.now() + LOCK_MS; a.n = 0; }
  attempts.set(ip, a);
}

// ---- plumbing --------------------------------------------------------------------------------

function send(res, status, body, headers) {
  const s = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    // The dashboard is same-origin; nothing else has any business calling this API.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, headers || {}));
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // A config API has no reason to accept a large body; refusing early avoids buffering junk.
      if (size > MAX_BODY) { reject(new Error('request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('malformed JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * What the browser is allowed to see. Portal and MAC are included because you cannot edit a line
 * you cannot see — but the response is no-store, behind a session, and same-origin only.
 */
function lineView(line, session) {
  return {
    id: line.id,
    name: line.name,
    portal: line.portal,
    mac: line.mac,
    port: line.port || null,
    password: line.password,
    maxConnections: line.maxConnections,
    unmetered: line.unmetered === true,
    remuxLive: line.remuxLive === true,
    delivery: line.delivery === 'redirect' ? 'redirect' : 'proxy',
    timezone: line.timezone,
    lang: line.lang,
    userAgent: line.userAgent || '',
    epgUrl: line.epgUrl || '',
    enabled: line.enabled !== false,
    status: session ? {
      connected: !!session.connected,
      reconnecting: !!session.reconnecting,
      error: session.lastError || null,
      active: session.activeConnections,
      // [{ key, viewers }] — a fanned-out channel shows one entry with several viewers, which is
      // the number that explains why the connection count is lower than the device count.
      streams: session.status().streams,
      // Catalogue build progress. A first walk of a large line takes minutes; without this the
      // dashboard looks connected while players still see empty categories.
      catalog: session.catalog ? Object.assign({}, session.catalog.progress, {
        channels: countOf(session.catalog, 'live:all'),
        films: countOf(session.catalog, 'vod:*'),
        series: countOf(session.catalog, 'series:*'),
      }) : null,
    } : { connected: false, error: 'not started', active: 0, streams: [], catalog: null },
  };
}

/** How many items are cached under a key, whatever their age. */
function countOf(catalog, key) {
  try {
    const v = catalog._stale(key);
    return Array.isArray(v) ? v.length : 0;
  } catch (e) { return 0; }
}

// ---- routes ----------------------------------------------------------------------------------

async function handle(req, res, url, ctx) {
  const { config, pool, applyConfig } = ctx;
  const p = url.pathname.replace(/\/+$/, '');
  const method = (req.method || 'GET').toUpperCase();
  const authed = validSession(cookieFrom(req));

  // ---- login / logout ------------------------------------------------------------------------
  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    if (locked(ip)) {
      return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    }
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    if (!config.checkAdmin(body.password)) {
      noteFailure(ip);
      log('failed login from ' + ip);
      return send(res, 401, { error: 'Wrong password' });
    }
    attempts.delete(ip);
    const token = newSession();
    return send(res, 200, { ok: true }, {
      // HttpOnly so a script cannot read it; SameSite=Strict so another site cannot ride it.
      'Set-Cookie': COOKIE + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' +
        Math.floor(SESSION_MS / 1000),
    });
  }

  if (p === '/api/logout' && method === 'POST') {
    const t = cookieFrom(req);
    if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, {
      'Set-Cookie': COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
  }

  if (p === '/api/session') {
    return send(res, 200, { authed: authed, portRange: [PORT_MIN, PORT_MAX] });
  }

  // ---- everything past here needs a session --------------------------------------------------
  if (!authed) return send(res, 401, { error: 'Not signed in' });

  if (p === '/api/lines' && method === 'GET') {
    return send(res, 200, {
      lines: config.lines().map((l) => lineView(l, pool.get(l.id))),
      portRange: [PORT_MIN, PORT_MAX],
    });
  }

  if (p === '/api/lines' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const r = config.add(body);
    if (!r.ok) return send(res, 400, { error: r.error });
    applyConfig();
    log('line added: ' + r.line.name);
    return send(res, 200, { line: lineView(r.line, pool.get(r.line.id)) });
  }

  const lineMatch = p.match(/^\/api\/lines\/([A-Za-z0-9_-]+)$/);
  if (lineMatch) {
    const id = lineMatch[1];
    if (method === 'PUT' || method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
      const r = config.update(id, body);
      if (!r.ok) return send(res, 400, { error: r.error });
      applyConfig();
      log('line updated: ' + r.line.name);
      return send(res, 200, { line: lineView(r.line, pool.get(r.line.id)) });
    }
    if (method === 'DELETE') {
      const r = config.remove(id);
      if (!r.ok) return send(res, 404, { error: r.error });
      applyConfig();
      log('line removed');
      return send(res, 200, { ok: true });
    }
  }

  // Force a catalogue rebuild, for when a provider has added content and you'd rather not wait
  // for the cache to expire on its own.
  const rebuild = p.match(/^\/api\/lines\/([A-Za-z0-9_-]+)\/rebuild$/);
  if (rebuild && method === 'POST') {
    const s = pool.get(rebuild[1]);
    if (!s || !s.catalog) return send(res, 404, { error: 'That line is not running' });
    s.catalog.clear();
    s.catalog.warm().catch(() => {});      // deliberately not awaited: this takes minutes
    return send(res, 200, { ok: true });
  }

  // Reconnect a single line, for when a portal has dropped it and you'd rather not restart
  // everything and interrupt the other lines.
  const reconnect = p.match(/^\/api\/lines\/([A-Za-z0-9_-]+)\/reconnect$/);
  if (reconnect && method === 'POST') {
    const s = pool.get(reconnect[1]);
    if (!s) return send(res, 404, { error: 'That line is not running' });
    s.stop();
    try {
      await s.connect();
      return send(res, 200, { ok: true, connected: true });
    } catch (e) {
      return send(res, 200, { ok: true, connected: false, error: (e && e.message) || String(e) });
    }
  }

  // Try a portal and MAC before committing them, so a typo is caught here rather than by a player
  // failing silently three screens later.
  if (p === '/api/test' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    return await testPortal(res, body);
  }

  if (p === '/api/password' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    if (!config.checkAdmin(body.current)) return send(res, 401, { error: 'Current password is wrong' });
    const r = config.setAdminPassword(body.next);
    if (!r.ok) return send(res, 400, { error: r.error });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'No such endpoint' });
}

/**
 * A throwaway handshake against a candidate portal. It deliberately does NOT touch the pool: a test
 * of a MAC already in use would evict that line's live session, which is precisely the behaviour
 * this whole service exists to avoid.
 */
async function testPortal(res, body) {
  const { validateLine } = require('./config');
  const v = validateLine(Object.assign({ password: 'testtest' }, body), null, []);
  if (!v.ok) return send(res, 400, { error: v.error });

  const StalkerClient = require('./stalker');
  const client = new StalkerClient({
    portal: v.line.portal,
    mac: v.line.mac,
    timezone: v.line.timezone,
    lang: v.line.lang,
    userAgent: v.line.userAgent,
  });

  const timer = setTimeout(() => { try { client.abort && client.abort(); } catch (e) {} }, 20000);
  try {
    await client.authenticate();
    let account = null;
    try { account = await client.getAccountInfo(); } catch (e) { /* optional detail */ }
    clearTimeout(timer);
    return send(res, 200, {
      ok: true,
      message: 'Portal answered and the MAC was accepted',
      account: account ? {
        status: account.status || account.blocked === undefined ? undefined : account.blocked,
        expires: account.phone || account.end_date || account.expires || null,
        tariff: account.tariff_plan || account.tariff || null,
      } : null,
    });
  } catch (e) {
    clearTimeout(timer);
    return send(res, 200, { ok: false, message: (e && e.message) || String(e) });
  }
}

module.exports = { handle, validSession, COOKIE };
