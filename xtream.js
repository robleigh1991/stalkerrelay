'use strict';
/**
 * The Xtream Codes façade.
 *
 * Devices speak Xtream because everything does — TiviMate, VLC, OTT Navigator, our own apps. They
 * authenticate here with the profile's MAC as the username, never to the portal, which is what
 * lets several devices share one line without evicting each other's session.
 *
 * Contract details that matter, each one learned from something breaking:
 *   - get_live_streams / get_vod_streams / get_series with NO category_id must return EVERYTHING.
 *     That is how a client asks for "All", and answering with an empty array makes a populated
 *     library look empty.
 *   - stream_id must round-trip to the same item every time, independent of filters and category.
 *   - Play URLs are /live/<user>/<pass>/<id>.<ext>, and the id is all we get back — so the mapping
 *     lives in the catalogue, not in a guess about how the portal names its media.
 */
const { URL } = require('url');
const crypto = require('crypto');

// Fallback only, for a line configured before per-line passwords existed. Anything created through
// the dashboard carries its own.
const ENV_PASSWORD = process.env.RELAY_PASSWORD || 'stbplayer';

function passwordOf(session) {
  return (session && session.cfg && session.cfg.password) || ENV_PASSWORD;
}

/**
 * Which line is this request for?
 *
 * On a line's own port the answer is fixed — `bound` is that line, and the username is whatever the
 * player felt like sending. On the shared port the username is the MAC, the way Xtream clients
 * expect to address a specific account.
 */
function sessionFor(pool, bound, user) {
  return bound || pool.byMac(user);
}

/**
 * Say out loud why a request was refused.
 *
 * A player only ever shows "HTTP 401", which is true and useless — a wrong username and a wrong
 * password look identical from the sofa. The response stays deliberately vague so the network
 * can't be used to enumerate which MACs exist; the specific reason goes to the container log,
 * where the person who can act on it is the only one reading.
 */
function logDenial(pool, bound, user, where) {
  try {
    if (!bound && !pool.byMac(user)) {
      const known = pool.list().map((s) => s.cfg.mac).filter(Boolean);
      console.log('[relay] ' + where + ': refused username "' + user + '" — no line has that MAC. ' +
        (known.length ? 'Configured: ' + known.join(', ') : 'No lines are configured.'));
    } else {
      console.log('[relay] ' + where + ': refused — wrong password for "' +
        ((bound && bound.name) || user) + '"');
    }
  } catch (e) {}
}

function json(res, body, status) {
  const s = JSON.stringify(body);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(s);
}

function authOk(session, pass) {
  const want = passwordOf(session);
  const got = String(pass == null ? '' : pass);
  if (got.length !== want.length) return false;
  // Constant-time: this is the only thing standing between the network and someone's subscription.
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** Host the device used to reach us, so generated URLs point back here and not at localhost. */
function selfBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return proto + '://' + (host || 'localhost');
}

function playUrl(base, user, pass, kind, id, ext) {
  return base + '/' + kind + '/' + encodeURIComponent(user) + '/' + encodeURIComponent(pass) +
    '/' + id + '.' + (ext || 'ts');
}

// ---- shaping ---------------------------------------------------------------------------------

function liveItem(ch, catId, num) {
  return {
    num: num,
    name: ch.name || '',
    stream_type: 'live',
    stream_id: ch.streamId,
    stream_icon: ch.logo || '',
    epg_channel_id: ch.epgId || '',
    added: '0',
    category_id: String(catId || ''),
    custom_sid: '',
    tv_archive: ch.archive ? 1 : 0,
    direct_source: '',
    tv_archive_duration: 0,
  };
}

function movieItem(m, catId, num) {
  return {
    num: num,
    name: m.name || '',
    stream_type: 'movie',
    stream_id: m.streamId,
    stream_icon: m.poster || '',
    rating: m.rating || '',
    rating_5based: ratingOf5(m.rating),
    added: '0',
    category_id: String(catId || m.categoryId || ''),
    container_extension: 'mp4',
    custom_sid: '',
    direct_source: '',
  };
}

function seriesItem(s, catId, num) {
  return {
    num: num,
    name: s.name || '',
    series_id: s.streamId,
    cover: s.poster || '',
    plot: '',
    cast: '',
    director: '',
    genre: '',
    releaseDate: s.year || '',
    last_modified: '0',
    rating: s.rating || '',
    rating_5based: ratingOf5(s.rating),
    backdrop_path: [],
    youtube_trailer: '',
    episode_run_time: '',
    category_id: String(catId || s.categoryId || ''),
  };
}

function ratingOf5(r) {
  const n = parseFloat(r);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round((n / 2) * 10) / 10;
}

function cats(list) {
  return (list || []).map((c) => ({
    category_id: String(c.id),
    category_name: c.title || '',
    parent_id: 0,
  }));
}

/** Items in a category, or all of them when none was asked for. */
function inCategory(items, catId, key) {
  if (!catId || catId === '*') return items;
  const want = String(catId);
  return items.filter((it) => String(it[key] || it.categoryId || it.genreId || '') === want);
}

// ---- handlers --------------------------------------------------------------------------------

async function playerApi(req, res, url, pool, bound) {
  const q = url.searchParams;
  const user = q.get('username') || '';
  const pass = q.get('password') || '';
  const session = sessionFor(pool, bound, user);
  if (!session || !authOk(session, pass)) {
    logDenial(pool, bound, user, 'player_api');
    return json(res, { user_info: { auth: 0, message: 'Wrong username or password' } }, 401);
  }
  const password = passwordOf(session);

  try {
    await session.ensure();
  } catch (e) {
    return json(res, { user_info: { auth: 0, message: (e && e.message) || 'portal unavailable' } }, 503);
  }

  const cat = session.catalog;
  const action = (q.get('action') || '').trim();
  const base = selfBase(req);
  const catId = q.get('category_id');

  if (!action) return json(res, userInfo(session, base, user, password));

  switch (action) {
    case 'get_live_categories':
      return json(res, cats(await cat.liveCategories()));

    case 'get_live_streams': {
      const all = await cat.liveChannels();
      const list = inCategory(all, catId, 'genreId');
      return json(res, list.map((ch, i) => liveItem(ch, catId || ch.genreId, i + 1)));
    }

    case 'get_vod_categories':
      return json(res, cats(await cat.vodCategories()));

    case 'get_vod_streams': {
      const list = await cat.list('vod', catId);
      return json(res, list.map((m, i) => movieItem(m, catId, i + 1)));
    }

    case 'get_series_categories':
      return json(res, cats(await cat.seriesCategories()));

    case 'get_series': {
      const list = await cat.list('series', catId);
      return json(res, list.map((s, i) => seriesItem(s, catId, i + 1)));
    }

    case 'get_series_info': {
      const sid = q.get('series_id') || q.get('series');
      const info = await cat.episodes(sid);
      const entry = cat.resolve(sid);
      const episodes = {};
      Object.keys(info.episodes).forEach((sn) => {
        episodes[sn] = info.episodes[sn].map((e, i) => ({
          id: String(e.id),
          episode_num: e.episodeNum,
          title: e.title,
          container_extension: e.container || 'mp4',
          info: {},
          custom_sid: '',
          added: '0',
          season: parseInt(sn, 10),
          direct_source: playUrl(base, user, password, 'series', e.id, e.container || 'mp4'),
        }));
      });
      return json(res, {
        seasons: info.seasons.map((s) => ({
          air_date: '', episode_count: (info.episodes[String(s.number)] || []).length,
          id: s.number, name: s.name, overview: '', season_number: s.number,
          cover: s.cover, cover_big: s.cover,
        })),
        info: {
          name: (entry && entry.name) || '', cover: '', plot: '', cast: '', director: '',
          genre: '', releaseDate: '', last_modified: '0', rating: '', rating_5based: 0,
          backdrop_path: [], youtube_trailer: '', episode_run_time: '', category_id: '',
        },
        episodes: episodes,
      });
    }

    case 'get_short_epg':
    case 'get_simple_data_table': {
      const entry = cat.resolve(q.get('stream_id'));
      if (!entry) return json(res, { epg_listings: [] });
      const chId = entry.item && entry.item.id;
      const epg = await session.client.getShortEpg(chId).catch(() => null);
      return json(res, { epg_listings: (epg || []).map(shortEpgRow) });
    }

    default:
      return json(res, []);
  }
}

function shortEpgRow(p) {
  return {
    id: String(p.id || ''),
    epg_id: '',
    title: b64(p.title || ''),
    lang: '',
    start: p.start || '',
    end: p.stop || '',
    description: b64(p.descr || ''),
    channel_id: '',
    start_timestamp: String(Math.floor((p.startTs || 0) / 1000)),
    stop_timestamp: String(Math.floor((p.stopTs || 0) / 1000)),
  };
}

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

function userInfo(session, base, user, password) {
  const host = new URL(base);
  return {
    user_info: {
      username: user,
      password: password,
      message: '',
      auth: 1,
      status: 'Active',
      exp_date: null,
      is_trial: '0',
      active_cons: String(session.activeConnections),
      created_at: '0',
      max_connections: String(session.maxConnections),
      allowed_output_formats: ['ts', 'm3u8'],
    },
    server_info: {
      url: host.hostname,
      port: host.port || '80',
      https_port: '443',
      server_protocol: host.protocol.replace(':', ''),
      rtmp_port: '0',
      timezone: session.cfg.timezone || 'Europe/London',
      timestamp_now: Math.floor(Date.now() / 1000),
      time_now: new Date().toISOString().replace('T', ' ').slice(0, 19),
    },
  };
}

/** The M3U playlist, for players that want a list rather than the API. */
async function playlist(req, res, url, pool, bound) {
  const q = url.searchParams;
  const user = q.get('username') || '';
  const session = sessionFor(pool, bound, user);
  if (!session || !authOk(session, q.get('password'))) {
    logDenial(pool, bound, user, 'playlist');
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('unauthorized');
  }
  const password = passwordOf(session);
  await session.ensure();
  const base = selfBase(req);
  const cat = session.catalog;
  const channels = await cat.liveChannels();
  const catsById = {};
  (await cat.liveCategories()).forEach((c) => { catsById[String(c.id)] = c.title; });

  const lines = ['#EXTM3U url-tvg="' + base + '/xmltv.php?username=' + encodeURIComponent(user) +
    '&password=' + encodeURIComponent(password) + '"'];
  channels.forEach((ch) => {
    const group = catsById[String(ch.genreId)] || 'Other';
    lines.push('#EXTINF:-1 tvg-id="' + (ch.epgId || '') + '" tvg-name="' + esc(ch.name) +
      '" tvg-logo="' + (ch.logo || '') + '" group-title="' + esc(group) + '",' + (ch.name || ''));
    lines.push(playUrl(base, user, password, 'live', ch.streamId, 'ts'));
  });
  const body = lines.join('\n') + '\n';
  res.writeHead(200, {
    'Content-Type': 'audio/x-mpegurl; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function esc(s) { return String(s || '').replace(/"/g, "'"); }

module.exports = {
  playerApi, playlist, selfBase, playUrl, authOk, passwordOf, sessionFor, logDenial,
};
