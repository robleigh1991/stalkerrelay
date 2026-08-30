'use strict';
/**
 * STB Player Relay — one portal, many devices.
 *
 * Run it once on the network; point every device at it. It holds the single portal session, so
 * nothing evicts anything else, and it enforces the line's connection limit itself with a clear
 * message instead of the portal's bare 456.
 *
 * Endpoints (Xtream-compatible, so any player works):
 *   /player_api.php?username=<MAC>&password=<pass>[&action=...]
 *   /get.php?username=<MAC>&password=<pass>            M3U playlist
 *   /xmltv.php?username=<MAC>&password=<pass>          EPG
 *   /live/<MAC>/<pass>/<id>.ts                         live stream (fanned out)
 *   /movie/<MAC>/<pass>/<id>.mp4                       film      (byte-resumable)
 *   /series/<MAC>/<pass>/<id>.mp4                      episode   (byte-resumable)
 *   /status                                            what's connected and playing
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { SessionPool } = require('./session');
const { Catalog } = require('./catalog');
const { Broadcast, relayFile, viewerStream } = require('./stream');
const xtream = require('./xtream');
const epg = require('./epg');

const PORT = parseInt(process.env.RELAY_PORT, 10) || 4700;
const PROFILES_FILE = process.env.RELAY_PROFILES_FILE || '/data/profiles.json';
const STATE_FILE = process.env.RELAY_STATE_FILE ||
  path.join(path.dirname(PROFILES_FILE), 'relay-state.json');

const pool = new SessionPool();

// ---- profiles --------------------------------------------------------------------------------

function loadProfiles() {
  // Environment-only configuration, so the simplest deployment needs no file at all.
  if (process.env.RELAY_PORTAL && process.env.RELAY_MAC) {
    return [{
      id: '1',
      name: process.env.RELAY_NAME || 'default',
      portal: process.env.RELAY_PORTAL,
      mac: process.env.RELAY_MAC,
      timezone: process.env.RELAY_TZ || 'Europe/London',
      lang: process.env.RELAY_LANG || 'en',
      userAgent: process.env.RELAY_UA || '',
      maxConnections: parseInt(process.env.RELAY_MAX_CONNECTIONS, 10) || 2,
      epgUrl: process.env.RELAY_EPG_URL || '',
    }];
  }
  try {
    const raw = fs.readFileSync(PROFILES_FILE, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : (list.profiles || []);
  } catch (e) {
    log('no profiles at ' + PROFILES_FILE + ' (' + ((e && e.code) || e) + ')');
    return [];
  }
}

function applyProfiles() {
  const sessions = pool.load(loadProfiles());
  sessions.forEach((s) => {
    if (!s.catalog) s.catalog = new Catalog(s);
    // Connect eagerly: the portal session is the scarce thing, so establish it once at start
    // rather than on the first device request.
    s.connect().catch(() => {});
  });
  hydrateState();
  log(sessions.length + ' profile(s) loaded');
  return sessions;
}

// ---- id persistence --------------------------------------------------------------------------
// Stream ids must survive a restart: a player stores favourites by id, and a play URL issued
// before the restart should still resolve to the same channel.

function hydrateState() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return; }
  pool.list().forEach((s) => {
    const mine = saved && saved[s.id];
    if (mine && s.catalog) s.catalog.hydrate(mine);
  });
  log('stream ids restored');
}

let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 5000);
  if (saveTimer.unref) saveTimer.unref();
}

function saveState() {
  const out = {};
  pool.list().forEach((s) => { if (s.catalog) out[s.id] = s.catalog.dehydrate(); });
  const tmp = STATE_FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, STATE_FILE);       // atomic: a crash can't leave a half-written file
  } catch (e) {
    log('could not save state: ' + ((e && e.message) || e));
  }
}

// ---- playback --------------------------------------------------------------------------------

/**
 * Resolve a stream id to a playable URL, asking the portal for a fresh link.
 *
 * The link is created per playback because portal links are short-lived and often single-use;
 * caching one and replaying it is how you get a 401 ten minutes later.
 */
async function resolveStream(session, entry) {
  const type = entry.kind === 'live' ? 'itv' : 'vod';
  const seriesEp = entry.item && entry.item.seriesEp != null ? entry.item.seriesEp : null;
  const chId = entry.kind === 'live' && entry.item ? entry.item.id : null;
  const link = await session.client.createLink(type, entry.cmd, seriesEp, chId);
  if (!link || !link.url) throw new Error('The portal did not return a playable link');
  return link.url;
}

async function handlePlay(req, res, kind, parts) {
  const user = decodeURIComponent(parts[1] || '');
  const pass = decodeURIComponent(parts[2] || '');
  const idPart = String(parts[3] || '');
  const streamId = idPart.replace(/\.[a-z0-9]+$/i, '');

  const session = pool.byMac(user);
  if (!session || !xtream.authOk(pass)) return text(res, 401, 'unauthorized');

  try { await session.ensure(); }
  catch (e) { return text(res, 503, 'portal unavailable: ' + ((e && e.message) || e)); }

  const entry = session.catalog.resolve(streamId);
  if (!entry) return text(res, 404, 'unknown stream id ' + streamId);

  const headers = session.client.streamContext
    ? headersFrom(session.client.streamContext())
    : {};

  // LIVE: shared. Several devices on one channel is one connection on the line.
  if (entry.kind === 'live') {
    let lease;
    try {
      lease = await session.lease('live:' + streamId, async () => {
        const url = await resolveStream(session, entry);
        const b = new Broadcast(url, headers);
        await b.start();
        b.close = b.close.bind(b);
        return b;
      });
    } catch (e) {
      if (e && e.busy) return text(res, 503, e.message);
      return text(res, 502, 'could not start stream: ' + ((e && e.message) || e));
    }

    const broadcast = lease.upstream;
    const v = viewerStream();
    broadcast.addViewer(v);
    res.writeHead(200, {
      'Content-Type': broadcast.contentType || 'video/mp2t',
      'Cache-Control': 'no-cache',
      Connection: 'close',
    });
    v.pipe(res);

    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      broadcast.removeViewer(v);
      lease.release();
    };
    req.on('close', done);
    res.on('close', done);
    res.on('error', done);
    return;
  }

  // FILE: not shared — two people watching the same film are at different points, and a file has
  // a real byte offset to resume from.
  let lease;
  try {
    lease = await session.lease('file:' + streamId + ':' + Date.now(), async () => ({
      close: () => {},
    }));
  } catch (e) {
    if (e && e.busy) return text(res, 503, e.message);
    return text(res, 502, (e && e.message) || 'could not start stream');
  }

  let url;
  try { url = await resolveStream(session, entry); }
  catch (e) { lease.release(); return text(res, 502, 'could not get a link: ' + ((e && e.message) || e)); }

  let released = false;
  const done = () => { if (!released) { released = true; lease.release(); } };
  req.on('close', done);
  res.on('close', done);

  relayFile(url, headers, req, res);
}

function headersFrom(ctx) {
  const h = {};
  if (!ctx) return h;
  if (ctx.ua) h['User-Agent'] = ctx.ua;
  if (ctx.referer) h.Referer = ctx.referer;
  if (ctx.cookie) h.Cookie = ctx.cookie;
  if (ctx.auth) h.Authorization = 'Bearer ' + ctx.auth;
  h.Accept = '*/*';
  return h;
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(String(body));
}

// ---- routing ---------------------------------------------------------------------------------

async function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://relay'); }
  catch (e) { return text(res, 400, 'bad request'); }

  const p = url.pathname;
  const parts = p.replace(/^\/+|\/+$/g, '').split('/');

  try {
    if (p === '/player_api.php' || p === '/panel_api.php') return await xtream.playerApi(req, res, url, pool);
    if (p === '/get.php' || p === '/playlist.m3u') return await xtream.playlist(req, res, url, pool);
    if (p === '/xmltv.php' || p === '/epg.xml') return await epg.serve(req, res, url, pool);
    if (p === '/status') return json(res, { profiles: pool.list().map((s) => s.status()) });
    if (p === '/health') return json(res, { ok: true });

    if (parts.length >= 4 && ['live', 'movie', 'series'].indexOf(parts[0]) >= 0) {
      return await handlePlay(req, res, parts[0], parts);
    }
    if (p === '/' ) return json(res, { name: 'stbplayer-relay', endpoints: ['/player_api.php', '/get.php', '/xmltv.php', '/status'] });
    text(res, 404, 'not found');
  } catch (e) {
    log('handler error on ' + p + ': ' + ((e && e.stack) || e));
    if (!res.headersSent) text(res, 500, 'relay error: ' + ((e && e.message) || e));
  }
}

function json(res, body) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function log(msg) { try { console.log('[relay] ' + msg); } catch (e) {} }

function start() {
  applyProfiles();
  // Ids change as catalogues are walked; persist them periodically rather than on every write.
  setInterval(saveStateSoon, 60000).unref();

  const server = http.createServer(handler);
  // Live streams are long-lived; the default 2-minute header timeout would cut them off.
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.listen(PORT, '0.0.0.0', () => log('listening on :' + PORT));

  const shutdown = () => {
    log('shutting down');
    saveState();
    pool.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { start, handler, pool, applyProfiles, loadProfiles };
