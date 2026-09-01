'use strict';
/**
 * Fetching a stream from the provider and relaying it to one or more devices.
 *
 * The hard-won behaviour here is the same as the desktop proxy's, for the same reasons:
 *
 *   - A source that hangs up mid-stream must not look like a finished file. Piping ends the
 *     response on any upstream stop, so a drop is indistinguishable from success: the player
 *     reports a complete (short) file and nothing retries.
 *   - Re-opening differs by kind. A FILE resumes with `Range: bytes=N-` and must see a 206 from
 *     exactly that offset; appending a 200-from-zero would splice the start of the film into the
 *     middle. LIVE has no byte offsets at all — a ranged request gets refused — so it re-opens
 *     with no Range and appends, and the demuxer absorbs the discontinuity.
 *   - A 5xx is usually "not ready yet", not "no", so the first request retries with backoff.
 *
 * What's new here versus the desktop version is FAN-OUT: one upstream can feed several devices.
 * A live stream is a broadcast, so late joiners get the stream from now on rather than from the
 * beginning, which is what you want for TV and the only thing that works without buffering it all.
 */
const http = require('http');
const https = require('https');
const { PassThrough } = require('stream');
const { URL } = require('url');
const crypto = require('crypto');

const LEGACY = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT || 0;

const CONNECT_TIMEOUT = 20000;
const MAX_REDIRECTS = 6;
const RESUME_MAX = 20;                                  // re-opens per stream before giving up
const REOPEN_BACKOFF = [300, 800, 2000, 4000, 6000];
const RETRY_5XX = [400, 1200, 2500, 4000];
// A live upstream that dies faster than this, or before delivering this many bytes, is contention
// (another channel on the same line evicted it), not a normal reconnect. Back off instead of
// re-opening instantly, which would machine-gun the line and ping-pong two channels into killing
// each other. A stream that runs past HEALTHY_MS/BYTES is healthy and resets the resume counter.
const MIN_ALIVE_MS = 4000;
// Eviction = a re-open that dies almost instantly having delivered essentially nothing. Keep this
// small: a source that handed over even a modest chunk before dropping is healthy churn and must be
// re-opened at once, not throttled. (Too high and normal fast-cycling live gets starved.)
const MIN_ALIVE_BYTES = 4 * 1024;
const STILLBORN_BACKOFF = [500, 1000, 2000, 4000, 8000];
// Live sources here hand out ~20s of stream per play_token then end cleanly. Each segment IS a
// healthy run, so the reset must fire inside one segment or the resume counter marches to the cap
// on a stream that is actually fine.
const HEALTHY_MS = 10000;
const HEALTHY_BYTES = 512 * 1024;

function isTlsError(e) {
  if (!e) return false;
  const c = e.code || '';
  if (c === 'EPROTO' || c === 'ERR_SSL_WRONG_VERSION_NUMBER' || String(c).indexOf('ERR_SSL') === 0) return true;
  return /SSL|TLS|sslv3|handshake|cipher|alert|wrong version|decryption|unsupported protocol/i.test(e.message || '');
}

function tlsOpts(u, mode) {
  const o = { servername: u.hostname, rejectUnauthorized: false };
  if (mode === 'legacy') {
    o.minVersion = 'TLSv1';
    o.ciphers = 'DEFAULT@SECLEVEL=0';
    o.secureOptions = LEGACY;
  }
  return o;
}

/**
 * One GET, following redirects. Modern TLS first, relaxed ciphers only as a fallback — the legacy
 * fingerprint is what bot protection flags, so it must not be the default.
 */
function request(target, headers, opts, cb) {
  opts = opts || {};
  let redirects = opts.redirects == null ? MAX_REDIRECTS : opts.redirects;
  const mode = opts.tls || 'modern';

  let u;
  try { u = new URL(target); }
  catch (e) { return cb(new Error('Invalid URL: ' + JSON.stringify(String(target)).slice(0, 200))); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return cb(new Error('Unsupported protocol: ' + u.protocol));
  }

  const lib = u.protocol === 'https:' ? https : http;
  const reqOpts = { method: opts.method || 'GET', headers: headers || {} };
  if (u.protocol === 'https:') Object.assign(reqOpts, tlsOpts(u, mode));

  let settled = false;
  const done = (err, res) => { if (!settled) { settled = true; cb(err, res, u.toString()); } };

  let req;
  try {
    req = lib.request(u, reqOpts, (res) => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        // Resolve here, where the Location is still in hand. Letting a bad one through surfaces
        // later as a bare "Invalid URL" naming nothing.
        try { next = new URL(res.headers.location, u).toString(); }
        catch (e) {
          return done(new Error('Source redirected to an unparseable URL: ' +
            JSON.stringify(String(res.headers.location)).slice(0, 200)));
        }
        return request(next, headers, Object.assign({}, opts, { redirects: redirects - 1, tls: 'modern' }), cb);
      }
      try { if (res.socket) res.socket.setTimeout(0); } catch (e) {}
      done(null, res);
    });
  } catch (e) { return done(e); }

  req.setTimeout(CONNECT_TIMEOUT, () => req.destroy(new Error('Timed out connecting')));
  req.on('error', (e) => {
    if (u.protocol === 'https:' && mode === 'modern' && isTlsError(e)) {
      return request(target, headers, Object.assign({}, opts, { tls: 'legacy' }), cb);
    }
    done(e);
  });
  req.end();
  return req;
}

/** GET with the first-request 5xx retry. A relay or portal is often briefly unready, not broken. */
function requestWithRetry(target, headers, opts, cb, attempt) {
  attempt = attempt || 0;
  request(target, headers, opts, (err, res, finalUrl) => {
    const status = res && res.statusCode;
    const transient = status === 502 || status === 503 || status === 504;
    if (!err && !transient) return cb(err, res, finalUrl);
    if (res) res.resume();
    if (attempt < RETRY_5XX.length) {
      const wait = RETRY_5XX[attempt];
      log('source ' + (err ? (err.code || err.message) : status) + ' — retrying in ' + wait + 'ms');
      return setTimeout(() => requestWithRetry(target, headers, opts, cb, attempt + 1), wait);
    }
    cb(err || new Error('HTTP ' + status), res, finalUrl);
  });
}

/**
 * A live upstream that several viewers can attach to.
 *
 * Late joiners receive from the moment they attach — a live broadcast has no beginning to catch up
 * to, and holding one would mean buffering the whole thing in memory.
 */
class Broadcast {
  // `refresh` (optional): async () => a fresh play URL. A live play_token is short-lived — the
  // source ends the stream when it expires — so re-opening the same URL just replays a dead token.
  // With refresh, each re-open mints a new link (like the desktop proxy, which re-hits the relay
  // for a fresh token every time), keeping one unbroken byte stream to the viewers.
  constructor(target, headers, refresh) {
    this.target = target;
    this.headers = headers || {};
    this.refresh = refresh || null;
    // The URL we actually streamed FROM after following redirects — the CDN edge, not the portal's
    // play endpoint. The edge is authorised by its own blob, independent of the MAG session, so
    // re-opening IT does not get revoked when another channel opens. We reopen the edge first and
    // only fall back to a fresh portal resolve when the edge blob itself has expired.
    this.edgeTarget = null;
    this.viewers = new Set();
    this.upstream = null;
    this.closed = false;
    this.resumes = 0;
    this.contentType = 'video/mp2t';
  }

  start() {
    return new Promise((resolve, reject) => {
      requestWithRetry(this.target, this.headers, {}, (err, res, finalUrl) => {
        if (err) return reject(err);
        if (res.statusCode >= 400) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { if (body.length < 500) body += c; });
          res.on('end', () => {
            const msg = body.replace(/\s+/g, ' ').trim().slice(0, 200);
            const e = new Error('Source refused the stream (HTTP ' + res.statusCode +
              (msg ? '): ' + msg : ')'));
            e.status = res.statusCode;
            reject(e);
          });
          res.on('error', () => reject(new Error('HTTP ' + res.statusCode)));
          return;
        }
        this.contentType = res.headers['content-type'] || this.contentType;
        if (finalUrl && finalUrl !== this.target) { this.edgeTarget = finalUrl; log('resolved edge: ' + finalUrl.slice(0, 90)); }
        this._attachUpstream(res);
        resolve(this);
      });
    });
  }

  _attachUpstream(res) {
    this.upstream = res;
    this._openedAt = Date.now();
    this._bytesThisOpen = 0;
    this._sample = '';
    res.on('data', (c) => {
      // Capture the first bytes so a stillborn open can be explained — a "stream" that is really a
      // 90-byte refusal ("max connections", an error page, an empty playlist) tells us what the
      // source is actually saying instead of leaving it a mystery.
      if (this._sample.length < 200) this._sample += c.toString('latin1').slice(0, 200 - this._sample.length);
      this._bytesThisOpen += c.length;
      // A stream that has run healthily for a while is not "resuming" — forgive earlier churn so a
      // long-lived channel never slowly accumulates toward the give-up cap.
      if (this.resumes && (Date.now() - this._openedAt) > HEALTHY_MS && this._bytesThisOpen > HEALTHY_BYTES) {
        this.resumes = 0;
      }
      for (const v of this.viewers) {
        // Never let one slow viewer stall the others or balloon memory: drop it instead.
        if (!v.write(c) && v.writableLength > 8 * 1024 * 1024) {
          log('viewer too slow, dropping');
          this.removeViewer(v);
        }
      }
    });
    const ended = (why) => {
      if (this.closed) return;
      res.removeAllListeners();
      const aliveMs = Date.now() - (this._openedAt || Date.now());
      // Died almost immediately AND delivered almost nothing: a genuine eviction (another stream on
      // this line took the slot), not a normal fast-cycling source. Re-opening instantly machine-guns
      // the line and ping-pongs two channels into mutual eviction, so back off. A source that handed
      // over a real chunk before dropping is healthy churn — re-open it at once (both conditions must
      // hold, or a short-lived-but-productive stream gets throttled and starves the viewer).
      if (aliveMs < MIN_ALIVE_MS && this._bytesThisOpen < MIN_ALIVE_BYTES && this.viewers.size) {
        if (this.resumes >= RESUME_MAX) { log('giving up after ' + this.resumes + ' re-opens'); return this.close(); }
        this.resumes++;
        const wait = STILLBORN_BACKOFF[Math.min(this.resumes - 1, STILLBORN_BACKOFF.length - 1)];
        const sample = (this._sample || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        log('upstream ' + why + ' after ' + this._bytesThisOpen + 'B/' + aliveMs + 'ms — contention, backing off ' +
          wait + 'ms (' + this.resumes + '/' + RESUME_MAX + ')' + (sample ? ' | source said: ' + sample : ''));
        return setTimeout(() => { if (!this.closed && this.viewers.size) this._reopen(why, 1); }, wait);
      }
      this._reopen(why);
    };
    res.on('end', () => ended('ended'));
    res.on('aborted', () => ended('aborted'));
    res.on('error', (e) => ended((e && (e.code || e.message)) || 'error'));
  }

  /**
   * Live has no byte offset to resume from, so re-open plainly and keep writing into the same
   * viewer streams. The demuxer sees a discontinuity, which is far better than the stream ending.
   */
  _reopen(why, tries) {
    if (this.closed) return;
    tries = tries || 0;
    if (!this.viewers.size) return this.close();
    if (this.resumes >= RESUME_MAX) {
      log('giving up after ' + this.resumes + ' re-opens');
      return this.close();
    }
    if (tries === 0) this.resumes++;
    log('upstream ' + why + ' — re-opening (' + this.resumes + '/' + RESUME_MAX + ', viewers=' + this.viewers.size + ')');

    const scheduleBackoff = () => {
      if (tries < REOPEN_BACKOFF.length) {
        return setTimeout(() => this._reopen(why, tries + 1), REOPEN_BACKOFF[tries]);
      }
      log('source will not come back');
      return this.close();
    };

    // Re-open the EDGE directly first. The edge blob is independent of the MAG session, so hitting it
    // again does NOT get revoked when another channel opens — which is the whole point: one portal
    // touch per channel, then the edge carries the stream. Only when the edge FAILS (its blob expired)
    // do we go back to the portal for a fresh link, which redirects us to a new edge. `refreshed`
    // guards against looping; we re-check viewers after the await so we never reconnect for nobody.
    const attempt = (target, refreshed) => {
      requestWithRetry(target, this.headers, {}, (err, res, finalUrl) => {
        if (this.closed) { if (res) res.destroy(); return; }
        if (err || !res || res.statusCode >= 400) {
          if (res) res.resume();
          if (this.refresh && !refreshed) {
            log('edge re-open failed — resolving a fresh link via the portal (viewers=' + this.viewers.size + ')');
            return this.refresh()
              .then((u) => {
                if (this.closed || !this.viewers.size) { log('refresh done but no viewers — stopping'); return this.close(); }
                if (u) this.target = u;
                this.edgeTarget = null;         // force the portal path; it will capture a new edge
                attempt(this.target, true);
              })
              .catch(() => { if (!this.closed && this.viewers.size) scheduleBackoff(); else this.close(); });
          }
          return scheduleBackoff();
        }
        if (finalUrl && finalUrl !== this.target) this.edgeTarget = finalUrl;
        this._attachUpstream(res);
      });
    };

    // Prefer the last-known edge; fall back to the portal URL (which redirects to a fresh edge).
    attempt(this.edgeTarget || this.target, false);
  }

  addViewer(stream) { this.viewers.add(stream); log('viewer added (viewers=' + this.viewers.size + ')'); }

  removeViewer(stream) {
    this.viewers.delete(stream);
    try { stream.end(); } catch (e) {}
    log('viewer removed (viewers=' + this.viewers.size + ')');
    // Not closed here: the lease lingers briefly so a channel surf back reuses this upstream. A
    // 0-viewer broadcast that then hits a source-end closes in _reopen; a refresh in flight is
    // guarded by the viewers check after it resolves. So no reconnect-into-the-void.
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    log('broadcast closed (viewers=' + this.viewers.size + ')');
    if (this.upstream) { try { this.upstream.destroy(); } catch (e) {} }
    for (const v of Array.from(this.viewers)) { try { v.end(); } catch (e) {} }
    this.viewers.clear();
  }
}

/**
 * Relay a FILE (a movie or episode) to one device, resuming by byte offset when the source drops.
 * Not shared: two people watching the same film are at different points, and a file has a real
 * offset to resume from, so each gets its own connection.
 */
function relayFile(target, headers, req, res) {
  let delivered = 0;
  let expected = 0;
  let resumes = 0;
  let closed = false;

  // The resolved play link is already authorized by its own play_token. Portal session headers
  // (Authorization: Bearer, Cookie) don't belong on it, and some panels 403/401/456 the /series/
  // and /movie/ play endpoints when Authorization is present — the exact reason a real player
  // sends the bare request. Start with the portal headers (some panels DO want the UA/Referer),
  // then fall back to a bare fetch once on an auth-shaped rejection.
  let activeHeaders = headers;
  let bareTried = false;
  const stripAuth = (h) => {
    // Fully bare, like a plain player: User-Agent (+ Accept) only. Portal Referer/Cookie/Bearer are
    // what a token-gated /series/ or /movie/ edge rejects; the play_token in the URL is the auth.
    const c = {};
    if (h['User-Agent']) c['User-Agent'] = h['User-Agent'];
    if (h.Accept) c.Accept = h.Accept;
    return c;
  };

  req.on('close', () => { closed = true; });

  const start = (rangeHeader, first) => {
    const h = Object.assign({}, activeHeaders);
    if (rangeHeader) h.Range = rangeHeader;

    requestWithRetry(target, h, {}, (err, up) => {
      if (closed) { if (up) up.destroy(); return; }
      if (err) {
        if (!res.headersSent) { res.writeHead(502); res.end('relay: ' + err.message); }
        else { try { res.destroy(); } catch (e) {} }
        return;
      }
      if (!bareTried && !res.headersSent &&
          (up.statusCode === 401 || up.statusCode === 403 || up.statusCode === 456) &&
          (activeHeaders.Authorization || activeHeaders.Cookie)) {
        // Panel refused the tokenised play link while portal auth headers were attached. Retry bare.
        bareTried = true;
        activeHeaders = stripAuth(activeHeaders);
        up.resume();
        log('file: ' + up.statusCode + ' with auth headers — retrying bare (play_token only)');
        return start(rangeHeader, first);
      }
      if (up.statusCode >= 400) {
        let body = '';
        up.setEncoding('utf8');
        up.on('data', (c) => { if (body.length < 500) body += c; });
        up.on('end', () => {
          if (!res.headersSent) { res.writeHead(up.statusCode); res.end(body); }
          else { try { res.destroy(); } catch (e) {} }
        });
        return;
      }

      if (first) {
        expected = parseInt(up.headers['content-length'] || '0', 10) || 0;
        const out = { 'Accept-Ranges': 'bytes' };
        ['content-type', 'content-length', 'content-range'].forEach((k) => {
          if (up.headers[k]) out[k] = up.headers[k];
        });
        res.writeHead(up.statusCode, out);
      }

      up.on('data', (c) => { delivered += c.length; });
      up.pipe(res, { end: false });

      let done = false;
      const finish = (why) => {
        if (done || closed) return;
        done = true;
        const complete = expected > 0 && delivered >= expected;
        if (complete) { try { res.end(); } catch (e) {} return; }
        if (resumes >= RESUME_MAX) {
          log('file: giving up at ' + delivered + ' bytes');
          try { res.destroy(); } catch (e) {}   // destroy, not end: end() reads as success
          return;
        }
        resumes++;
        log('file: source ' + why + ' at ' + delivered + ' — resuming (' + resumes + '/' + RESUME_MAX + ')');
        resumeAt(delivered);
      };
      up.on('end', () => finish('ended'));
      up.on('aborted', () => finish('aborted'));
      up.on('error', (e) => finish((e && (e.code || e.message)) || 'error'));
    });
  };

  const resumeAt = (offset) => {
    const want = offset;
    const h = Object.assign({}, activeHeaders, { Range: 'bytes=' + want + '-' });
    requestWithRetry(target, h, {}, (err, up) => {
      if (closed) { if (up) up.destroy(); return; }
      // Only a 206 from exactly where we stopped can be appended. A 200 means the server ignored
      // Range and is starting over, which would splice the beginning into the middle of the film.
      const cr = (up && up.headers['content-range']) || '';
      const m = /bytes\s+(\d+)-/i.exec(cr);
      const ok = !err && up && up.statusCode === 206 && m && parseInt(m[1], 10) === want;
      if (!ok) {
        log('file: source will not resume (HTTP ' + (up && up.statusCode) + ')');
        if (up) up.resume();
        try { res.destroy(); } catch (e) {}
        return;
      }
      up.on('data', (c) => { delivered += c.length; });
      up.pipe(res, { end: false });
      let done = false;
      const finish = (why) => {
        if (done || closed) return;
        done = true;
        if (expected > 0 && delivered >= expected) { try { res.end(); } catch (e) {} return; }
        if (resumes >= RESUME_MAX) { try { res.destroy(); } catch (e) {} return; }
        resumes++;
        log('file: source ' + why + ' at ' + delivered + ' — resuming (' + resumes + '/' + RESUME_MAX + ')');
        resumeAt(delivered);
      };
      up.on('end', () => finish('ended'));
      up.on('aborted', () => finish('aborted'));
      up.on('error', (e) => finish((e && (e.code || e.message)) || 'error'));
    });
  };

  start(req.headers && req.headers.range, true);
}

/** A per-viewer stream fed by a Broadcast. */
function viewerStream() { return new PassThrough({ highWaterMark: 4 * 1024 * 1024 }); }

function log(msg) { try { console.log('[stream] ' + msg); } catch (e) {} }

module.exports = { request, requestWithRetry, Broadcast, relayFile, viewerStream };
