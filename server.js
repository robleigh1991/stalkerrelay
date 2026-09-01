'use strict';
/**
 * STB Player Relay — one portal, many devices.
 *
 * Two kinds of listener run here:
 *
 *   The DASHBOARD port (default 4700) serves the management UI, the admin API, and the shared
 *   Xtream endpoint where a line is addressed by its MAC as the username.
 *
 *   A LINE port (optional, one per line) serves exactly one line. The player still sends a username
 *   and password, but the username is ignored — the port already says which line this is. That
 *   matters because several players cope badly with two accounts on one host:port, and because a
 *   line can then be handed to someone as a plain server address without explaining MACs.
 *
 * Device-facing endpoints, identical on both:
 *   /player_api.php   /get.php   /xmltv.php
 *   /live|movie|series/<user>/<pass>/<id>.<ext>
 *   /status  /health
 *
 * The admin API and dashboard exist ONLY on the dashboard port. A line port must never expose
 * configuration: those ports are the ones most likely to get forwarded through a router.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { SessionPool } = require('./session');
const { Catalog } = require('./catalog');
const { Broadcast, relayFile, viewerStream } = require('./stream');
const { Config } = require('./config');
const xtream = require('./xtream');
const epg = require('./epg');
const admin = require('./admin');
const ui = require('./ui');

const PORT = parseInt(process.env.RELAY_PORT, 10) || 4700;
const STATE_FILE = process.env.RELAY_STATE_FILE || '/data/relay-state.json';

// The built catalogue, kept separately from the id map: it is far larger, changes on a different
// schedule, and losing it costs only a re-walk, whereas losing ids breaks saved favourites.
const CATALOG_FILE = process.env.RELAY_CATALOG_FILE ||
  path.join(path.dirname(STATE_FILE), 'relay-catalog.json');

const pool = new SessionPool();
const config = new Config();

// Line id -> http.Server, for the ports that lines bind individually.
const lineServers = new Map();

function log(msg) { try { console.log('[relay] ' + msg); } catch (e) {} }

// ---- applying configuration ------------------------------------------------------------------

/**
 * Bring running state in line with the stored config. Safe to call repeatedly — the pool only
 * rebuilds sessions whose portal details actually changed, so editing a line's name or password
 * doesn't drop anyone's stream.
 */
function applyConfig() {
  const lines = config.lines().filter((l) => l.enabled !== false);
  // Only the sessions pool.load actually created or reconnected — so adding or editing one line
  // connects and warms that line alone and leaves every other line's catalogue untouched.
  const started = pool.load(lines);
  started.forEach((s) => {
    if (!s.catalog) s.catalog = new Catalog(s);
    // Connect eagerly: the portal session is the scarce resource, so it is established once at
    // start rather than during someone's first channel change.
    s.connect().then(() => {
      // Then build the catalogue in the background. Xtream has no pagination, so a client asking
      // for a category expects the whole list at once; walking the portal's pages while a player
      // waits is what made some categories take a minute to open.
      s.catalog.warmSoon();
    }).catch(() => {});
  });
  hydrateState();
  hydrateCatalogs();
  syncLineServers(lines);
  return started;
}

/** Start, move, and stop the per-line listeners to match the config. */
function syncLineServers(lines) {
  const wanted = new Map();
  lines.forEach((l) => { if (l.port) wanted.set(String(l.id), l); });

  // Stop anything no longer wanted, or whose port moved.
  for (const [id, entry] of Array.from(lineServers.entries())) {
    const want = wanted.get(id);
    if (!want || want.port !== entry.port) {
      try { entry.server.close(); } catch (e) {}
      lineServers.delete(id);
      log('line port ' + entry.port + ' closed');
    }
  }

  for (const [id, line] of wanted.entries()) {
    if (lineServers.has(id)) continue;
    const session = pool.get(id);
    if (!session) continue;
    listenForLine(id, line.port, session);
  }
}

function listenForLine(id, port, session) {
  // The handler closes over the session id, not the session object: editing a line can replace the
  // session instance, and a stale reference would keep serving the old portal details.
  const server = http.createServer((req, res) => handler(req, res, { lineId: id }));
  tuneForStreaming(server);

  server.on('error', (e) => {
    // A port clash must not take the whole relay down — the other lines are still working, and the
    // dashboard is how the person is going to fix this.
    log('line "' + (session.name || id) + '" could not bind port ' + port + ': ' +
      ((e && e.message) || e));
    lineServers.delete(String(id));
  });

  server.listen(port, '0.0.0.0', () => {
    log('line "' + (session.name || id) + '" listening on :' + port);
  });
  lineServers.set(String(id), { server: server, port: port });
}

function tuneForStreaming(server) {
  // Live streams are long-lived; Node's default two-minute timeouts would cut them off mid-match.
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}

// ---- id persistence --------------------------------------------------------------------------
// Stream ids must survive a restart: players store favourites by id, and a play URL issued before
// the restart should still resolve to the same channel.

function hydrateState() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return; }
  pool.list().forEach((s) => {
    const mine = saved && saved[s.id];
    if (mine && s.catalog) s.catalog.hydrate(mine);
  });
}

/**
 * Restore the built catalogue. Timestamps are preserved, so anything older than its TTL is served
 * immediately and refreshed in the background rather than being treated as current — a restart
 * should cost nobody a page walk, but it should not freeze the listing at whatever it was either.
 */
function hydrateCatalogs() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch (e) { return; }
  let restored = 0;
  pool.list().forEach((s) => {
    const mine = saved && saved[s.id];
    if (mine && s.catalog) restored += s.catalog.loadLists(mine);
  });
  if (restored) log('catalogue restored from disk');
}

function saveCatalogs() {
  const out = {};
  pool.list().forEach((s) => { if (s.catalog) out[s.id] = s.catalog.dumpLists(); });
  const tmp = CATALOG_FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, CATALOG_FILE);
  } catch (e) {
    log('could not save catalogue: ' + ((e && e.message) || e));
  }
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

async function handlePlay(req, res, kind, parts, bound) {
  const user = decodeURIComponent(parts[1] || '');
  const pass = decodeURIComponent(parts[2] || '');
  const idPart = String(parts[3] || '');
  const streamId = idPart.replace(/\.[a-z0-9]+$/i, '');

  const session = xtream.sessionFor(pool, bound, user);
  if (!session || !xtream.authOk(session, pass)) {
    xtream.logDenial(pool, bound, user, 'playback');
    return text(res, 401, 'unauthorized');
  }

  try { await session.ensure(); }
  catch (e) { return text(res, 503, 'portal unavailable: ' + ((e && e.message) || e)); }

  const entry = session.catalog.resolve(streamId);
  if (!entry) return text(res, 404, 'unknown stream id ' + streamId);

  // REDIRECT delivery: mint the link, hand the edge URL straight to the device, and step out of the
  // byte path entirely. The relay still brokers the single portal auth; the device streams the edge
  // directly. Only safe when the edge is reachable from the device and its token isn't IP-locked to
  // the relay — otherwise use proxy delivery. No lease is taken: the relay carries no bytes here.
  if ((session.cfg && session.cfg.delivery) === 'redirect') {
    let url;
    try { url = await resolveStream(session, entry); }
    catch (e) { return text(res, 502, 'could not get a link: ' + ((e && e.message) || e)); }
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-cache' });
    return res.end();
  }

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
      }, { label: entry.name || ('#' + streamId), kind: 'live' });
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

  // FILE: one slot per viewer, not per request.
  //
  // Two people watching the same film ARE two connections — they're at different offsets, so the
  // bytes can't be shared the way a live channel's can. But one player commonly opens several
  // overlapping range requests for a single film (seeking, buffering ahead, a fresh request per
  // scrub), and keying the lease by time made each of those its own connection. A couple of seeks
  // and someone had eaten the whole line by themselves.
  //
  // Keying by viewer instead means those requests join one lease: the count reflects who is
  // watching, which is what the provider is actually counting.
  const viewer = (req.socket && req.socket.remoteAddress) || 'unknown';
  let lease;
  try {
    lease = await session.lease('file:' + streamId + ':' + viewer, async () => ({
      close: () => {},
    }), { label: entry.name || ('#' + streamId), kind: entry.kind });
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

function json(res, body, status) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

// ---- routing ---------------------------------------------------------------------------------

/**
 * @param opts.lineId  set on a line's own port; the request is then locked to that line and the
 *                     dashboard and admin API are not routed at all.
 */
async function handler(req, res, opts) {
  const isLinePort = !!(opts && opts.lineId);
  const bound = isLinePort ? pool.get(opts.lineId) : null;

  // A line whose session vanished (deleted while a player was connected) must not fall through to
  // the shared behaviour, which would let any MAC be addressed on this port.
  if (isLinePort && !bound) return text(res, 503, 'this line is no longer configured');

  let url;
  try { url = new URL(req.url, 'http://relay'); }
  catch (e) { return text(res, 400, 'bad request'); }

  const p = url.pathname;
  const parts = p.replace(/^\/+|\/+$/g, '').split('/');

  try {
    if (p === '/health') return json(res, { ok: true });

    // ---- management, dashboard port only -----------------------------------------------------
    if (!isLinePort) {
      if (p === '/api' || p.indexOf('/api/') === 0) {
        return await admin.handle(req, res, url, { config, pool, applyConfig, lineServers });
      }
      if (p === '/' || p === '/index.html') return ui.serve(req, res);
    }

    // ---- devices ------------------------------------------------------------------------------
    if (p === '/player_api.php' || p === '/panel_api.php') {
      return await xtream.playerApi(req, res, url, pool, bound);
    }
    if (p === '/get.php' || p === '/playlist.m3u') {
      return await xtream.playlist(req, res, url, pool, bound);
    }
    if (p === '/xmltv.php' || p === '/epg.xml') {
      return await epg.serve(req, res, url, pool, bound);
    }
    if (parts.length >= 4 && ['live', 'movie', 'series'].indexOf(parts[0]) >= 0) {
      return await handlePlay(req, res, parts[0], parts, bound);
    }

    // Public status: counts only, no credentials. The dashboard has a richer authenticated view.
    if (p === '/status') {
      const list = (bound ? [bound] : pool.list()).map((s) => publicStatus(s));
      return json(res, { profiles: list });
    }

    if (isLinePort && p === '/') {
      return json(res, { name: 'stbplayer-relay', line: bound.name });
    }
    text(res, 404, 'not found');
  } catch (e) {
    log('handler error on ' + p + ': ' + ((e && e.stack) || e));
    if (!res.headersSent) text(res, 500, 'relay error: ' + ((e && e.message) || e));
  }
}

/** Deliberately excludes portal, MAC and password — /status needs no authentication. */
function publicStatus(s) {
  return {
    name: s.name,
    connected: !!s.connected,
    active_connections: s.activeConnections,
    max_connections: s.maxConnections,
  };
}

// ---- startup ---------------------------------------------------------------------------------

function start() {
  config.load();
  applyConfig();
  log(config.lines().length + ' line(s) configured');

  // Ids change as catalogues are walked; persist them periodically rather than on every write.
  setInterval(saveStateSoon, 60000).unref();
  // The catalogue is bigger and changes less often, so it is written less frequently.
  setInterval(saveCatalogs, 5 * 60000).unref();

  const server = tuneForStreaming(http.createServer((req, res) => handler(req, res, null)));
  server.listen(PORT, '0.0.0.0', () => {
    log('dashboard on http://0.0.0.0:' + PORT);
  });

  const shutdown = () => {
    log('shutting down');
    saveState();
    saveCatalogs();
    // Stop mid-walk rather than holding the container open for a catalogue nobody is waiting for.
    pool.list().forEach((s) => { if (s.catalog) s.catalog.stop(); });
    pool.stopAll();
    for (const entry of lineServers.values()) { try { entry.server.close(); } catch (e) {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = {
  start, handler, pool, config, applyConfig, lineServers, listenForLine, tuneForStreaming,
  saveCatalogs, hydrateCatalogs,
};
