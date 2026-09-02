'use strict';
/**
 * Stalker / Ministra portal client (MAG STB emulation).
 * Runs in the Electron main process, so there is no CORS and we can set
 * arbitrary headers (Cookie, User-Agent, Authorization) just like a real MAG box.
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
let socks = null;
try { socks = require('./socks'); } catch (e) { /* optional */ }

const UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2721 Safari/533.3';

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

/**
 * Does this response body say "your MAG device token is no longer valid"?
 *
 * The handshake token (Authorization: Bearer …, paired with the mac cookie) is NOT the play_token
 * in a stream URL — play_token authorises one link, the device token authorises the whole session.
 * Portals expire it aggressively, and re-handshaking on another device invalidates it outright,
 * so this shows up mid-use rather than at connect time.
 *
 * Panels report it inconsistently: some 401, some return 200 with an error envelope like
 *   {"error":"MAG_TOKEN_INVALID","message":"Invalid or expired MAG device token","status":401}
 * so the body is worth checking whatever the status line said.
 */
function isTokenError(body) {
  if (!body || typeof body !== 'string') return false;
  if (body.length > 4000) return false;                 // a media payload, not an error envelope
  return /MAG_TOKEN_INVALID|token[_ ]?(is[_ ]?)?(invalid|expired)|invalid or expired mag/i.test(body);
}

// Patch a blank stream id into a channel cmd / play URL. Handles the common shapes:
//   ...&stream=&extension=ts      -> ...&stream=<id>&extension=ts
//   http://host/ch/_0            -> http://host/ch/<id>_0
//   http://host/ch/  (trailing)  -> http://host/ch/<id>
// A no-op when the id is already present, so it's safe to call unconditionally.
function fillStreamId(s, id) {
  if (!s || id == null) return s;
  id = String(id);
  return s
    .replace(/([?&]stream=)(?=&|\s|$)/g, '$1' + id)   // empty stream= query param
    .replace(/(\/ch\/)_/g, '$1' + id + '_')           // /ch/_0 placeholder
    .replace(/(\/ch\/)(?=\s|$)/g, '$1' + id);         // /ch/ with nothing after
}

class StalkerClient {
  constructor(cfg) {
    this.cfg = Object.assign({ timezone: 'Europe/London', lang: 'en' }, cfg || {});
    this.token = null;
    this.profileLoaded = false;
    // In-flight handshake, shared by concurrent callers (see authenticate).
    this._authPromise = null;

    // Normalise portal -> base origin + api endpoint candidates
    const raw = (this.cfg.portal || '').trim().replace(/\/+$/, '');
    let u;
    try { u = new URL(raw.match(/^https?:\/\//) ? raw : 'http://' + raw); }
    catch (e) { u = null; }
    this.origin = u ? `${u.protocol}//${u.host}` : raw;

    // Common Stalker API paths. We probe these during handshake.
    this.apiCandidates = [
      '/portal.php',
      '/stalker_portal/server/load.php',
      '/server/load.php',
      '/c/portal.php'
    ];
    this.api = null; // resolved after successful handshake

    const mac = (this.cfg.mac || '').toUpperCase();
    this.mac = mac;
    // Device identifiers derived from the MAC, the way STB emulators do it.
    this.sn = md5(mac).substring(0, 13).toUpperCase();
    this.deviceId = sha1(mac).toUpperCase();
    this.deviceId2 = this.deviceId;
    this.sig = sha1(this.sn + mac).toUpperCase();

    // Optional SOCKS proxy so the portal sees the proxy IP, matching the streams.
    this.socksAgents = (socks && this.cfg.proxyEnabled && this.cfg.proxyUrl)
      ? socks.makeProxyAgents(this.cfg.proxyUrl) : null;
  }

  cookie() {
    const tz = encodeURIComponent(this.cfg.timezone || 'Europe/London');
    return `mac=${encodeURIComponent(this.mac)}; stb_lang=${this.cfg.lang || 'en'}; timezone=${tz}`;
  }

  // Auth context forwarded by the proxy to every stream/segment request.
  // NOTE: the MAC is sent RAW here (not percent-encoded). The portal API tolerates the encoded
  // form, but /play/ endpoints string-match the MAC against the session — sending
  // "mac=00%3A1A%3A..." there fails the match and the panel answers a bodyless 456.
  // This mirrors the header set of known-working reference clients exactly.
  streamContext() {
    const tz = this.cfg.timezone || 'Europe/London';
    return {
      ua: this.cfg.userAgent || UA,
      referer: this.origin + '/c/',
      origin: this.origin,
      cookie: `mac=${this.mac}; stb_lang=${this.cfg.lang || 'en'}; timezone=${tz}`,
      auth: this.token || ''
    };
  }

  // Params for an external stream proxy (e.g. a Nuxt/Render stalker-proxy) that fetches the
  // stream from a whitelisted IP to bypass a Cloudflare IP block on the portal.
  externalParams() {
    return { portalurl: this.cfg.portal || (this.origin + '/c'), macaddress: this.mac, token: this.token || '' };
  }

  _request(fullUrl, extraHeaders) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(fullUrl); } catch (e) { return reject(new Error('Bad URL: ' + fullUrl)); }
      const lib = u.protocol === 'https:' ? https : http;
      const headers = Object.assign({
        'User-Agent': this.cfg.userAgent || UA,
        'Referer': this.origin + '/c/',
        'Accept': '*/*',
        'X-User-Agent': 'Model: MAG250; Link: WiFi',
        'Cookie': this.cookie()
      }, extraHeaders || {});
      if (this.token) headers['Authorization'] = 'Bearer ' + this.token;

      const reqOpts = { method: 'GET', headers, timeout: 15000 };
      if (this.socksAgents) reqOpts.agent = u.protocol === 'https:' ? this.socksAgents.https : this.socksAgents.http;
      const req = lib.request(u, reqOpts, (res) => {
        // follow simple redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location : this.origin + res.headers.location;
          return resolve(this._request(loc, extraHeaders));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
      req.on('error', reject);
      req.end();
    });
  }

  _buildUrl(apiPath, params) {
    const qs = new URLSearchParams(Object.assign({ JsHttpRequest: '1-xml' }, params)).toString();
    return `${this.origin}${apiPath}?${qs}`;
  }

  // One portal request + envelope parsing. Throws with .tokenExpired when the device token is dead.
  async _callOnce(params, apiPathOverride) {
    const apiPath = apiPathOverride || this.api || this.apiCandidates[0];
    const url = this._buildUrl(apiPath, params);
    const res = await this._request(url);

    // Some panels answer 200 with an error envelope instead of a 401, so check the body either way.
    if (isTokenError(res.body)) {
      const e = new Error('Portal rejected the device token (expired or superseded)');
      e.tokenExpired = true;
      e.status = res.status;
      throw e;
    }
    if (res.status !== 200) {
      const e = new Error(`HTTP ${res.status} from portal`);
      e.status = res.status;
      if (res.status === 401) e.tokenExpired = true;
      throw e;
    }
    try { return JSON.parse(res.body); }
    catch (e) {
      const snippet = (res.body || '').replace(/\s+/g, ' ').slice(0, 140);
      throw new Error('Portal did not return JSON (auth/portal path issue): ' + snippet);
    }
  }

  /**
   * Core call, with automatic recovery from an expired device token.
   *
   * ensureAuth() can't cover this on its own — it only handshakes when the token is MISSING, so a
   * token that is present but expired would be resent forever. Portal sessions are short-lived and
   * a login elsewhere on the same MAC invalidates this one, so it happens mid-use, not at connect.
   *
   * Retried once. If a freshly minted token is rejected too, the problem is the account rather than
   * the session, and looping would just hammer the portal. `_authInFlight` stops the handshake's
   * own calls from recursing back in here.
   */
  async _call(params, apiPathOverride, _retried) {
    try {
      return await this._callOnce(params, apiPathOverride);
    } catch (e) {
      if (!e || !e.tokenExpired || _retried || this._authInFlight) throw e;
      try { console.log('[stalker] device token rejected — re-handshaking'); } catch (x) {}
      this.token = null;
      this.profileLoaded = false;
      await this.authenticate();
      return this._call(params, apiPathOverride, true);
    }
  }

  // ---------------- Auth ----------------
  async authenticate() {
    // Dedup concurrent handshakes. The mid-use re-handshake fires from inside _call (token-expiry
    // retry), which Session never sees — so without a lock here, two simultaneous re-handshakes on
    // ONE line (two devices opening different channels at once, or a play racing the keepalive) each
    // mint a device token that invalidates the other's, and one stream dies with MAG_TOKEN_INVALID —
    // the exact churn this relay exists to prevent. A single in-flight handshake hands both callers
    // the same fresh token.
    if (this._authPromise) return this._authPromise;
    this.token = null;
    // Stops the handshake's own calls from recursing back into _call's token-expiry retry.
    this._authInFlight = true;
    this._authPromise = this._authenticate();
    try {
      return await this._authPromise;
    } finally {
      this._authInFlight = false;
      this._authPromise = null;
    }
  }

  async _authenticate() {
    let lastErr = null;
    // Probe each candidate api path with a handshake until one returns a token.
    for (const apiPath of this.apiCandidates) {
      try {
        const hs = await this._call({ type: 'stb', action: 'handshake', token: '', prehash: '0' }, apiPath);
        const token = hs && hs.js && hs.js.token;
        if (token) {
          this.token = token;
          this.api = apiPath;
          break;
        }
      } catch (e) { lastErr = e; }
    }
    if (!this.token) throw new Error('Handshake failed on all known portal paths. ' + (lastErr ? lastErr.message : ''));

    // get_profile registers the box / MAC against the token.
    await this._call({
      type: 'stb', action: 'get_profile',
      hd: '1', ver: 'ImageDescription: 0.2.18-r23-250; ImageDate: Wed Aug 29 10:49:53 EEST 2018; PORTAL version: 5.6.2; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c',
      num_banks: '2', sn: this.sn, stb_type: 'MAG250', client_type: 'STB',
      image_version: '218', video_out: 'hdmi',
      device_id: this.deviceId, device_id2: this.deviceId2,
      signature: this.sig, auth_second_step: '0',
      hw_version: '1.7-BD-00', not_valid_token: '0',
      metrics: JSON.stringify({ mac: this.mac, sn: this.sn, model: 'MAG250', type: 'STB', uid: '' }),
      hw_version_2: sha1(this.mac).substring(0, 40),
      timestamp: Math.floor(Date.now() / 1000),
      api_signature: '262', prehash: sha1(this.mac + this.sn).substring(0, 40)
    }).catch(() => { /* some portals reject get_profile but still stream */ });

    this.profileLoaded = true;
    return { token: this.token, api: this.api, sn: this.sn, deviceId: this.deviceId };
  }

  async ensureAuth() { if (!this.token) await this.authenticate(); }

  /** Force a brand-new device token. Used when the STREAM host (not the portal) rejects the session. */
  async reauthenticate() {
    this.token = null;
    this.profileLoaded = false;
    return this.authenticate();
  }

  async getAccountInfo() {
    await this.ensureAuth();
    const info = await this._call({ type: 'account_info', action: 'get_main_info' }).catch(() => null);
    const exp = await this._call({ type: 'stb', action: 'get_profile' }).catch(() => null);
    const js = (info && info.js) || {};
    return {
      mac: this.mac,
      phone: js.phone || (exp && exp.js && exp.js.phone) || '',
      endDate: js.end_date || (exp && exp.js && exp.js.phone) || '',
      fullName: js.fname || '',
      tariff: js.tariff_plan || ''
    };
  }

  // ---------------- Live TV ----------------
  async getLiveGenres() {
    await this.ensureAuth();
    const r = await this._call({ type: 'itv', action: 'get_genres' });
    const list = (r && r.js) || [];
    return list.map((g) => ({ id: String(g.id), title: g.title, alias: g.alias }));
  }

  async getLiveChannels(genre, page) {
    await this.ensureAuth();
    const params = {
      type: 'itv', action: 'get_ordered_list',
      genre: genre || '*', force_ch_link_check: '', fav: '0', sortby: 'number',
      hd: '0', p: String(page || 1), from_ch_id: '0'
    };
    const r = await this._call(params);
    const js = (r && r.js) || {};
    const data = (js.data || []).map((c) => ({
      id: String(c.id),
      name: c.name,
      number: c.number,
      logo: c.logo ? this._logo(c.logo) : '',
      cmd: c.cmd || (Array.isArray(c.cmds) && c.cmds[0] && (c.cmds[0].cmd || c.cmds[0].url)) || '',
      cmds: c.cmds,
      genreId: String(c.tv_genre_id || ''),
      archive: c.tv_archive_duration || 0,
      epgId: c.xmltv_id || ''
    }));
    return { items: data, total: parseInt(js.total_items || data.length, 10), perPage: parseInt(js.max_page_items || 14, 10) };
  }

  _logo(logo) {
    if (!logo) return '';
    if (/^https?:\/\//.test(logo)) return logo;
    return this.origin + '/stalker_portal/misc/logos/320/' + logo.replace(/^\/+/, '');
  }

  getEpgUrl() { return ''; }

  async getShortEpg(chId) {
    await this.ensureAuth();
    const r = await this._call({ type: 'itv', action: 'get_short_epg', ch_id: String(chId), size: '12' }).catch(() => null);
    const list = (r && r.js) || [];
    return list.map(e => ({
      start: (parseInt(e.start_timestamp, 10) || 0) * 1000,
      stop: (parseInt(e.stop_timestamp, 10) || 0) * 1000,
      title: e.name || e.t_time || '', desc: e.descr || ''
    })).filter(x => x.start && x.stop).sort((a, b) => a.start - b.start);
  }

  // ---------------- VOD (Movies) ----------------
  async getVodCategories() {
    await this.ensureAuth();
    const r = await this._call({ type: 'vod', action: 'get_categories' });
    return ((r && r.js) || []).map((c) => ({ id: String(c.id), title: c.title }));
  }

  async getVodList(category, page, search, sort) {
    await this.ensureAuth();
    const params = {
      type: 'vod', action: 'get_ordered_list',
      category: category || '*', sortby: sort || 'added',
      p: String(page || 1), search: search || '', not_ended: '0', fav: '0'
    };
    const r = await this._call(params);
    return this._vodParse(r);
  }

  // ---------------- Series ----------------
  async getSeriesCategories() {
    await this.ensureAuth();
    const r = await this._call({ type: 'series', action: 'get_categories' });
    return ((r && r.js) || []).map((c) => ({ id: String(c.id), title: c.title }));
  }

  async getSeriesList(category, page, search, sort) {
    await this.ensureAuth();
    const params = {
      type: 'series', action: 'get_ordered_list',
      category: category || '*', sortby: sort || 'added',
      p: String(page || 1), search: search || '', not_ended: '0', fav: '0'
    };
    const r = await this._call(params);
    return this._vodParse(r);
  }

  // Episodes/seasons for a given series movie_id
  async getSeriesEpisodes(movieId, season) {
    await this.ensureAuth();
    const params = {
      type: 'series', action: 'get_ordered_list',
      movie_id: String(movieId), season_id: season != null ? String(season) : '0',
      category: '0', p: '1', sortby: 'added'
    };
    const r = await this._call(params);
    return this._vodParse(r);
  }

  _vodParse(r) {
    const js = (r && r.js) || {};
    const data = (js.data || []).map((m) => ({
      id: String(m.id),
      name: m.name,
      oname: m.o_name,
      description: m.description,
      poster: m.screenshot_uri ? this._poster(m.screenshot_uri) : (m.poster_url || ''),
      year: m.year,
      rating: m.rating_imdb || m.rating_kinopoisk || '',
      genre: m.genres_str || '',
      director: m.director || '',
      actors: m.actors || '',
      time: m.time || '',
      cmd: m.cmd,
      // NB: m.series is an ARRAY of episode numbers and the portal sends [] for plain movies.
      // `!!m.series` was therefore true for everything ([] is truthy in JS), flagging every movie
      // as a series. Require a non-empty array.
      isSeries: String(m.is_series || '0') === '1' || (Array.isArray(m.series) && m.series.length > 0),
      seasons: m.series || [],
      episodes: m.series || []
    }));
    return { items: data, total: parseInt(js.total_items || data.length, 10), perPage: parseInt(js.max_page_items || 14, 10) };
  }

  _poster(uri) {
    if (!uri) return '';
    if (/^https?:\/\//.test(uri)) return uri;
    return this.origin + uri;
  }

  // ---------------- Resolve a playable stream URL ----------------
  // type: 'itv' | 'vod' | 'series'
  async createLink(type, cmd, seriesEpisode, streamId) {
    await this.ensureAuth();
    // Some panels hand back channel cmds with a blank stream id (e.g. ".../ch/_0" or
    // "...&stream=&extension=ts"). create_link then echoes an empty stream= and the URL
    // carries no data. If we know the channel id, patch it into the cmd before sending so
    // the portal issues a play_token for the right stream. No-op when the id is present.
    let sendCmd = cmd;
    if (streamId) sendCmd = fillStreamId(sendCmd, streamId);

    // Is the channel cmd already a complete, tokenised play URL (stream + play_token both set)?
    const cmdMatch = (sendCmd || '').match(/https?:\/\/\S+/);
    const cmdUrl = cmdMatch ? cmdMatch[0] : '';
    const cmdComplete = /[?&]stream=[^&\s]+/.test(cmdUrl) && /[?&]play_token=[^&\s]+/.test(cmdUrl);

    // When the cmd is already a full tokenised URL, DON'T call create_link. On some panels that
    // call blanks the stream and mints a new token that invalidates the original one (-> 456).
    // The working reference clients just take this URL and swap ts->m3u8, so do the same.
    if (cmdComplete) {
      try { console.log('[createLink]', type, '| via: cmd-direct | url:', JSON.stringify(cmdUrl)); } catch (e) {}
      return { url: cmdUrl, raw: cmd, candidates: [cmdUrl] };
    }

    const params = { type, action: 'create_link', cmd: sendCmd, forced_storage: '0', disable_ad: '0' };
    if (seriesEpisode != null) params.series = String(seriesEpisode);
    if (type === 'itv') { params.forced_storage = 'undefined'; params.disable_ad = '0'; }
    // _call re-handshakes and retries once if the portal says the device token has expired.
    const r = await this._call(params);
    const js = (r && r.js) || {};
    let link = js.cmd || '';
    // cmd often looks like "ffmpeg http://host/stream" or "auto http://..."
    const m = link.match(/https?:\/\/\S+/);
    let url = m ? m[0] : link;

    const clHasStream = /[?&]stream=[^&\s]+/.test(url);
    let source = 'create_link';
    if (!clHasStream && cmdComplete) {
      // This panel blanked the stream in create_link. Prefer the original channel cmd (a matched
      // stream+token pair) but ALSO keep create_link's fresh-token variant as a candidate, since
      // some panels only accept the create_link token on the m3u8 endpoint.
      url = cmdUrl;
      source = 'original-cmd';
    } else if (streamId) {
      url = fillStreamId(url, streamId);   // create_link worked; just repair a blank id if any
    }

    // Ordered, de-duplicated candidate play URLs. The link handler probes each (as m3u8) until
    // one is accepted — so we try both the create_link token and the channel-list token.
    const clWithStream = m ? (streamId ? fillStreamId(m[0], streamId) : m[0]) : '';
    const candidates = [];
    const pushCand = (u) => { if (u && /[?&]stream=[^&\s]+/.test(u) && candidates.indexOf(u) === -1) candidates.push(u); };
    pushCand(url);                       // preferred (original-cmd token, or create_link when it worked)
    pushCand(clWithStream);              // create_link fresh-token variant
    if (!candidates.length && url) candidates.push(url);

    try { console.log('[createLink]', type, '| via:', source, '| sent cmd:', JSON.stringify(sendCmd), '| portal returned:', JSON.stringify(link), '| candidates:', JSON.stringify(candidates)); } catch (e) {}
    if (!candidates.length) throw new Error('Portal returned no stream link (channel/movie may be unavailable).');
    return { url: candidates[0], raw: link, candidates: candidates };
  }
}

module.exports = StalkerClient;
