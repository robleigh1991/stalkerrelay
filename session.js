'use strict';
/**
 * One portal session, shared by every device.
 *
 * THE PROBLEM THIS SOLVES
 * A Stalker portal allows one live session per MAC. Every handshake mints a new token and
 * invalidates the previous one, so two clients using the same line continuously evict each other —
 * which is exactly the MAG_TOKEN_INVALID / 401 churn you get running a desktop app and a relay
 * against the same MAC. Adding a phone makes it worse, not better.
 *
 * So the relay becomes the ONLY thing that ever talks to the portal. It handshakes once, keeps the
 * session warm, and re-auths when the portal expires it. Devices authenticate to the relay instead,
 * and can't evict one another because they never touch the portal at all.
 *
 * THE SECOND PROBLEM: CONNECTION LIMITS
 * A line also caps concurrent streams (the 456/459 family). Two devices on the same channel is two
 * upstream connections for identical bytes. `lease()` fans those out: the first viewer opens the
 * upstream, later viewers attach to it, and the connection closes when the last one leaves. Beyond
 * that, a budget refuses politely instead of letting the portal answer with a bare 456.
 */
const StalkerClient = require('./stalker');

// Portals expire idle sessions. A periodic cheap call keeps ours alive and surfaces expiry early,
// while the client's own token-expiry retry handles the re-handshake.
const KEEPALIVE_MS = 4 * 60 * 1000;

// How long a fanned-out upstream lingers with no viewers before closing. Channel surfing means
// leave-then-rejoin within a second or two; tearing down instantly would spend a connection slot
// re-opening what we just closed.
const LINGER_MS = 8000;

class Session {
  /**
   * @param cfg { id, name, portal, mac, timezone, lang, userAgent, maxConnections }
   */
  constructor(cfg) {
    this.cfg = Object.assign({ timezone: 'Europe/London', lang: 'en' }, cfg || {});
    this.id = String(this.cfg.id != null ? this.cfg.id : this.cfg.mac || 'default');
    this.name = this.cfg.name || this.cfg.portal || this.id;

    // The single client. Nothing else in the process opens a portal session for this MAC.
    this.client = new StalkerClient(this.cfg);

    // A line's concurrent-stream cap. Conservative default: most lines are 1-2, and guessing high
    // just moves the failure to the portal where the error is less useful.
    this.maxConnections = Math.max(1, parseInt(this.cfg.maxConnections, 10) || 2);

    this.leases = new Map();     // key -> { key, refs, upstream, closeTimer, meta }
    this.connected = false;
    this.lastError = null;
    this.keepAlive = null;
    this._authPromise = null;
  }

  /**
   * Authenticate once. Concurrent callers share the same in-flight handshake rather than racing to
   * mint tokens that invalidate each other — the failure mode this whole class exists to prevent.
   */
  async connect() {
    if (this.connected) return true;
    if (this._authPromise) return this._authPromise;

    this._authPromise = (async () => {
      try {
        await this.client.authenticate();
        this.connected = true;
        this.lastError = null;
        this._startKeepAlive();
        log(this, 'connected');
        return true;
      } catch (e) {
        this.connected = false;
        this.lastError = (e && e.message) || String(e);
        log(this, 'connect failed: ' + this.lastError);
        throw e;
      } finally {
        this._authPromise = null;
      }
    })();
    return this._authPromise;
  }

  async ensure() {
    if (!this.connected) await this.connect();
    return this.client;
  }

  _startKeepAlive() {
    if (this.keepAlive) return;
    this.keepAlive = setInterval(() => {
      // getAccountInfo is cheap and goes through _call, which re-handshakes by itself if the portal
      // has expired the token. Failure here is not fatal — the next real request will retry.
      this.client.getAccountInfo().catch((e) => {
        log(this, 'keep-alive failed: ' + ((e && e.message) || e));
      });
    }, KEEPALIVE_MS);
    if (this.keepAlive.unref) this.keepAlive.unref();
  }

  stop() {
    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
    for (const lease of Array.from(this.leases.values())) this._closeLease(lease, 'session stopped');
    this.connected = false;
  }

  // ---- connection budget + fan-out ------------------------------------------------------------

  /** Currently open upstream connections (a fanned-out lease counts once, however many viewers). */
  get activeConnections() { return this.leases.size; }

  /**
   * Take a lease on `key` (a channel or title). If one is already open, join it — that is the
   * whole point: two devices watching the same thing must not cost two slots on the line.
   *
   * `open()` is only called for a genuinely new stream, and only if the budget allows.
   * Returns { upstream, release } or throws a .busy error the caller can turn into a clear message.
   */
  async lease(key, open, meta) {
    key = String(key);
    let lease = this.leases.get(key);

    if (lease) {
      lease.refs++;
      if (lease.closeTimer) { clearTimeout(lease.closeTimer); lease.closeTimer = null; }
      log(this, 'lease join ' + ((lease.meta && lease.meta.label) || key) +
        ' (viewers=' + lease.refs + ')');
      return { upstream: lease.upstream, release: () => this._release(key), shared: true };
    }

    if (this.leases.size >= this.maxConnections) {
      const e = new Error('All ' + this.maxConnections + ' connections on this line are in use. ' +
        'Stop another stream and try again.');
      e.busy = true;
      e.code = 'LINE_BUSY';
      throw e;
    }

    // Reserve the slot BEFORE awaiting, or two simultaneous requests both see room and overshoot.
    lease = {
      key: key, refs: 1, upstream: null, closeTimer: null,
      // What a human should be told is playing — "BBC One", not "live:18236".
      meta: meta || null,
      at: Date.now(),
    };
    this.leases.set(key, lease);
    try {
      lease.upstream = await open();
    } catch (e) {
      this.leases.delete(key);
      throw e;
    }
    log(this, 'lease open ' + ((meta && meta.label) || key) +
      ' (' + this.leases.size + '/' + this.maxConnections + ')');
    return { upstream: lease.upstream, release: () => this._release(key), shared: false };
  }

  _release(key) {
    const lease = this.leases.get(key);
    if (!lease) return;
    lease.refs--;
    if (lease.refs > 0) {
      log(this, 'lease leave ' + key + ' (viewers=' + lease.refs + ')');
      return;
    }
    // Linger briefly: channel surfing back and forth shouldn't re-open the upstream each time.
    lease.closeTimer = setTimeout(() => this._closeLease(lease, 'idle'), LINGER_MS);
    if (lease.closeTimer.unref) lease.closeTimer.unref();
  }

  _closeLease(lease, why) {
    if (!lease) return;
    if (lease.closeTimer) { clearTimeout(lease.closeTimer); lease.closeTimer = null; }
    this.leases.delete(lease.key);
    const up = lease.upstream;
    if (up && typeof up.close === 'function') { try { up.close(); } catch (e) {} }
    log(this, 'lease close ' + lease.key + ' (' + why + ')');
  }

  status() {
    return {
      id: this.id,
      name: this.name,
      portal: this.cfg.portal || '',
      mac: this.cfg.mac || '',
      connected: this.connected,
      error: this.lastError,
      connections: this.activeConnections,
      maxConnections: this.maxConnections,
      streams: Array.from(this.leases.values()).map((l) => ({
        key: l.key,
        viewers: l.refs,
        label: (l.meta && l.meta.label) || l.key,
        kind: (l.meta && l.meta.kind) || (l.key.indexOf('live:') === 0 ? 'live' : 'file'),
        since: l.at || null,
      })),
    };
  }
}

function log(s, msg) { try { console.log('[session ' + s.id + '] ' + msg); } catch (e) {} }

/** All configured profiles, each with its own single portal session. */
class SessionPool {
  constructor() { this.sessions = new Map(); }

  load(profiles) {
    const wanted = new Set();
    (profiles || []).forEach((p) => {
      const id = String(p.id != null ? p.id : p.mac);
      wanted.add(id);
      const existing = this.sessions.get(id);
      // Only rebuild when something that affects the portal session actually changed — otherwise a
      // config reload would drop live streams for no reason.
      if (existing && sameConnection(existing.cfg, p)) {
        existing.cfg = Object.assign(existing.cfg, p);
        existing.maxConnections = Math.max(1, parseInt(p.maxConnections, 10) || existing.maxConnections);
        return;
      }
      if (existing) existing.stop();
      this.sessions.set(id, new Session(Object.assign({}, p, { id: id })));
    });
    for (const [id, s] of Array.from(this.sessions.entries())) {
      if (!wanted.has(id)) { s.stop(); this.sessions.delete(id); }
    }
    return this.list();
  }

  get(id) { return this.sessions.get(String(id)) || null; }

  /** Devices log in with the MAC as the username, the way Xtream clients expect. */
  byMac(mac) {
    const want = normalizeMac(mac);
    if (!want) return null;
    for (const s of this.sessions.values()) {
      if (normalizeMac(s.cfg.mac) === want) return s;
    }
    return null;
  }

  list() { return Array.from(this.sessions.values()); }
  stopAll() { this.list().forEach((s) => s.stop()); }
}

function sameConnection(a, b) {
  return (a.portal || '') === (b.portal || '')
    && normalizeMac(a.mac) === normalizeMac(b.mac)
    && (a.userAgent || '') === (b.userAgent || '');
}

function normalizeMac(m) {
  return String(m || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
}

module.exports = { Session, SessionPool, normalizeMac };
