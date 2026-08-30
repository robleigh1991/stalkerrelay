'use strict';
/**
 * EPG for devices, as XMLTV.
 *
 * Two sources, in order of preference:
 *   1. The provider's own XMLTV, if the profile names one (or the portal advertises one). Passed
 *      through and cached — it's usually a large file and refetching it per device is wasteful.
 *   2. Built from the portal's short-EPG, for portals with no XMLTV at all. Only "now and next"
 *      per channel, which is thin, but better than a blank guide.
 *
 * Cached hard: a guide is tens of megabytes and several devices will ask for it at once, each
 * request otherwise costing a portal round trip per channel.
 */
const { requestWithRetry } = require('./stream');

const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map();     // sessionId -> { at, body }

function cached(id) {
  const hit = cache.get(id);
  if (!hit || Date.now() - hit.at > CACHE_TTL) return null;
  return hit.body;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** XMLTV wants local time with an offset: 20260830183000 +0000 */
function xmltvTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + ' +0000';
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    requestWithRetry(url, { 'User-Agent': 'stbplayer-relay', Accept: '*/*' }, {}, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  });
}

/** Assemble a guide from the portal's per-channel short EPG. */
async function buildFromPortal(session) {
  const channels = await session.catalog.liveChannels();
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="stbplayer-relay">'];

  channels.forEach((ch) => {
    const id = ch.epgId || String(ch.streamId);
    out.push('  <channel id="' + esc(id) + '"><display-name>' + esc(ch.name) + '</display-name>' +
      (ch.logo ? '<icon src="' + esc(ch.logo) + '"/>' : '') + '</channel>');
  });

  // Sequential on purpose: this is one request per channel against a line that limits connections.
  // A guide that arrives slowly is much better than one that trips the cap and takes playback down.
  for (const ch of channels) {
    let progs = null;
    try { progs = await session.client.getShortEpg(ch.id); } catch (e) { progs = null; }
    if (!progs || !progs.length) continue;
    const id = ch.epgId || String(ch.streamId);
    progs.forEach((p) => {
      const start = xmltvTime(p.startTs);
      const stop = xmltvTime(p.stopTs);
      if (!start || !stop) return;
      out.push('  <programme start="' + start + '" stop="' + stop + '" channel="' + esc(id) + '">');
      out.push('    <title>' + esc(p.title) + '</title>');
      if (p.descr) out.push('    <desc>' + esc(p.descr) + '</desc>');
      out.push('  </programme>');
    });
  }
  out.push('</tv>');
  return Buffer.from(out.join('\n'), 'utf8');
}

async function serve(req, res, url, pool) {
  const q = url.searchParams;
  const user = q.get('username') || '';
  const session = pool.byMac(user);
  if (!session) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('unauthorized');
  }

  const send = (body) => {
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=1800',
    });
    res.end(body);
  };

  const hit = cached(session.id);
  if (hit) return send(hit);

  try {
    await session.ensure();
    const external = (session.cfg.epgUrl || '').trim() ||
      (session.client.getEpgUrl ? session.client.getEpgUrl() : '');

    let body;
    if (external) {
      body = await fetchUrl(external);
    } else {
      body = await buildFromPortal(session);
    }
    cache.set(session.id, { at: Date.now(), body: body });
    send(body);
  } catch (e) {
    // An empty but valid guide beats an error: players cope with no programmes, but a 500 makes
    // some of them drop the playlist entirely.
    const empty = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<tv/>', 'utf8');
    try { console.log('[epg] ' + ((e && e.message) || e)); } catch (x) {}
    send(empty);
  }
}

module.exports = { serve, xmltvTime, buildFromPortal };
