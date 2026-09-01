'use strict';
/**
 * Persistent configuration: the lines being relayed, and the dashboard's own password.
 *
 * Everything lives in one JSON file in the data volume, written atomically. It holds subscription
 * credentials — portal URLs and MACs — so it is created 0600 and never served to a browser without
 * an authenticated session.
 *
 * The admin password is stored as a scrypt hash, not in clear. That matters less for keeping a LAN
 * neighbour out than for the case where someone posts their config.json into a forum thread asking
 * for help, which people do constantly.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = process.env.RELAY_CONFIG_FILE || '/data/config.json';

// A line may bind its own port, but only inside this window. Without a bound, a typo in the
// dashboard could try to bind 22 or 443 — and in a container running as root, succeed.
const PORT_MIN = parseInt(process.env.RELAY_PORT_MIN, 10) || 4701;
const PORT_MAX = parseInt(process.env.RELAY_PORT_MAX, 10) || 4720;

const DEFAULTS = {
  timezone: process.env.RELAY_TZ || 'Europe/London',
  lang: process.env.RELAY_LANG || 'en',
  userAgent: '',
  maxConnections: 2,
  // When the provider counts connections only at the portal/create_link layer and leaves the
  // resolved edge URLs unmetered, `unmetered` lifts the relay's own cap so distinct streams aren't
  // refused. `delivery: 'redirect'` hands the edge URL to the device instead of piping the bytes.
  unmetered: false,
  delivery: 'proxy',
  // Run live through ffmpeg on the relay to smooth edge-swap timestamp discontinuities for strict
  // players (mobile). Costs CPU per active channel; leave off for desktop-only lines.
  remuxLive: false,
  epgUrl: '',
  enabled: true,
};

function log(msg) { try { console.log('[config] ' + msg); } catch (e) {} }

// ---- password hashing ------------------------------------------------------------------------

function hashPassword(plain, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(plain), s, 64).toString('hex');
  return { salt: s, hash: h };
}

function verifyPassword(plain, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const got = Buffer.from(crypto.scryptSync(String(plain), rec.salt, 64).toString('hex'));
  const want = Buffer.from(rec.hash);
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

// ---- validation ------------------------------------------------------------------------------

function cleanMac(m) {
  const hex = String(m || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

/**
 * Validate a line as submitted from the dashboard.
 * Returns { ok: true, line } or { ok: false, error } — never throws, because every one of these is
 * a message a person needs to read and act on.
 */
function validateLine(input, existing, all) {
  const line = Object.assign({}, DEFAULTS, existing || {}, input || {});

  const portal = String(line.portal || '').trim();
  if (!portal) return bad('A portal URL is required');
  let u;
  try { u = new URL(portal); } catch (e) { return bad('That portal URL is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return bad('The portal URL must start with http:// or https://');
  }
  line.portal = portal;

  const mac = cleanMac(line.mac);
  if (!mac) return bad('A MAC address needs 12 hex digits, like 00:1A:79:F2:B1:5D');
  line.mac = mac;

  line.name = String(line.name || '').trim().slice(0, 60) || u.hostname;

  const mc = parseInt(line.maxConnections, 10);
  if (!isFinite(mc) || mc < 1 || mc > 20) return bad('Connections must be between 1 and 20');
  line.maxConnections = mc;

  line.unmetered = line.unmetered === true || line.unmetered === 'true' || line.unmetered === '1';
  line.remuxLive = line.remuxLive === true || line.remuxLive === 'true' || line.remuxLive === '1';
  const delivery = String(line.delivery || 'proxy').trim().toLowerCase();
  line.delivery = delivery === 'redirect' ? 'redirect' : 'proxy';

  // A blank password would leave the line open to anyone who can reach the port.
  const pw = String(line.password == null ? '' : line.password);
  if (pw.length < 4) return bad('The line password must be at least 4 characters');
  line.password = pw;

  if (line.port === '' || line.port == null) {
    line.port = null;
  } else {
    const p = parseInt(line.port, 10);
    if (!isFinite(p)) return bad('The port must be a number');
    if (p < PORT_MIN || p > PORT_MAX) {
      return bad('The port must be between ' + PORT_MIN + ' and ' + PORT_MAX +
        ' (the range published by the container)');
    }
    line.port = p;
  }

  line.timezone = String(line.timezone || DEFAULTS.timezone).trim() || DEFAULTS.timezone;
  line.lang = String(line.lang || DEFAULTS.lang).trim() || DEFAULTS.lang;
  line.userAgent = String(line.userAgent || '').trim();
  line.epgUrl = String(line.epgUrl || '').trim();
  line.enabled = line.enabled !== false;

  // Uniqueness, checked against the other lines only.
  const others = (all || []).filter((l) => String(l.id) !== String(line.id));
  if (line.port != null && others.some((l) => l.port === line.port)) {
    return bad('Port ' + line.port + ' is already used by another line');
  }
  // Two lines on one MAC would evict each other's portal session — the precise failure this whole
  // service exists to prevent, so it is refused rather than merely warned about.
  if (others.some((l) => cleanMac(l.mac) === line.mac && (l.portal || '') === line.portal)) {
    return bad('Another line already uses that portal and MAC — they would evict each other');
  }

  return { ok: true, line: line };
}

function bad(error) { return { ok: false, error: error }; }

// ---- store -----------------------------------------------------------------------------------

class Config {
  constructor(file) {
    this.file = file || CONFIG_FILE;
    this.data = { version: 1, admin: null, lines: [] };
    this.loaded = false;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        version: parsed.version || 1,
        admin: parsed.admin || null,
        lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      };
      this.loaded = true;
      log(this.data.lines.length + ' line(s) loaded');
    } catch (e) {
      if (e && e.code === 'ENOENT') log('no config yet at ' + this.file);
      else log('could not read config (' + ((e && e.message) || e) + ') — starting empty');
      this.data = { version: 1, admin: null, lines: [] };
    }
    this._migrate();
    this._ensureAdmin();
    return this;
  }

  /**
   * First-run import. Someone upgrading from the env-only or profiles.json setup should find their
   * line already present rather than a blank dashboard and the assumption they misconfigured it.
   */
  _migrate() {
    if (this.data.lines.length) return;

    const imported = [];
    if (process.env.RELAY_PORTAL && process.env.RELAY_MAC) {
      imported.push({
        name: process.env.RELAY_NAME || 'Imported',
        portal: process.env.RELAY_PORTAL,
        mac: process.env.RELAY_MAC,
        maxConnections: parseInt(process.env.RELAY_MAX_CONNECTIONS, 10) || 2,
        password: process.env.RELAY_PASSWORD || 'stbplayer',
        epgUrl: process.env.RELAY_EPG_URL || '',
      });
    }

    const legacy = process.env.RELAY_PROFILES_FILE ||
      path.join(path.dirname(this.file), 'profiles.json');
    try {
      const list = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      (Array.isArray(list) ? list : (list.profiles || [])).forEach((p) => {
        imported.push(Object.assign({ password: process.env.RELAY_PASSWORD || 'stbplayer' }, p));
      });
    } catch (e) { /* absent is the normal case */ }

    imported.forEach((raw) => {
      const v = validateLine(raw, null, this.data.lines);
      if (v.ok) {
        v.line.id = newId();
        this.data.lines.push(v.line);
      } else {
        log('skipped an imported line: ' + v.error);
      }
    });

    if (this.data.lines.length) {
      log('imported ' + this.data.lines.length + ' line(s) from the previous configuration');
      this.save();
    }
  }

  /**
   * The dashboard must never be reachable without a password. If none is configured, generate one
   * and print it — an unguessable password in the logs is recoverable; a blank one is a mistake
   * nobody notices until it matters.
   */
  _ensureAdmin() {
    const fromEnv = process.env.RELAY_ADMIN_PASSWORD;
    if (fromEnv) {
      // Env always wins, so a forgotten password is fixable by redeploying with a new one.
      this.data.admin = Object.assign(hashPassword(fromEnv), { fromEnv: true });
      return;
    }
    if (this.data.admin && this.data.admin.hash && !this.data.admin.fromEnv) return;

    const generated = crypto.randomBytes(9).toString('base64url');
    this.data.admin = hashPassword(generated);
    this.save();
    log('');
    log('  No RELAY_ADMIN_PASSWORD set. Generated one for the dashboard:');
    log('');
    log('      ' + generated);
    log('');
    log('  Set RELAY_ADMIN_PASSWORD to choose your own; this one is not shown again.');
    log('');
  }

  checkAdmin(plain) { return verifyPassword(plain, this.data.admin); }

  setAdminPassword(plain) {
    if (String(plain || '').length < 8) {
      return bad('The dashboard password must be at least 8 characters');
    }
    if (this.data.admin && this.data.admin.fromEnv) {
      return bad('The password is set by RELAY_ADMIN_PASSWORD — change it there, not here');
    }
    this.data.admin = hashPassword(plain);
    this.save();
    return { ok: true };
  }

  lines() { return this.data.lines.slice(); }
  line(id) { return this.data.lines.find((l) => String(l.id) === String(id)) || null; }

  add(input) {
    const v = validateLine(input, null, this.data.lines);
    if (!v.ok) return v;
    v.line.id = newId();
    this.data.lines.push(v.line);
    this.save();
    return { ok: true, line: v.line };
  }

  update(id, input) {
    const existing = this.line(id);
    if (!existing) return bad('That line no longer exists');
    // id comes from the path, never the body — otherwise an update could overwrite a different line.
    const v = validateLine(Object.assign({}, input, { id: existing.id }), existing, this.data.lines);
    if (!v.ok) return v;
    v.line.id = existing.id;
    this.data.lines = this.data.lines.map((l) => (String(l.id) === String(id) ? v.line : l));
    this.save();
    return { ok: true, line: v.line };
  }

  remove(id) {
    const before = this.data.lines.length;
    this.data.lines = this.data.lines.filter((l) => String(l.id) !== String(id));
    if (this.data.lines.length === before) return bad('That line no longer exists');
    this.save();
    return { ok: true };
  }

  save() {
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 0600 from the moment it exists: it holds portal credentials.
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);   // atomic — a crash mid-write can't truncate the config
    } catch (e) {
      log('could not save: ' + ((e && e.message) || e));
      return false;
    }
    return true;
  }
}

function newId() { return crypto.randomBytes(6).toString('hex'); }

module.exports = {
  Config, validateLine, hashPassword, verifyPassword, cleanMac, newId,
  PORT_MIN, PORT_MAX, CONFIG_FILE,
};
