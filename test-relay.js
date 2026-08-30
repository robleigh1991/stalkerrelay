'use strict';
/**
 * The relay, against a mock Stalker portal.
 *
 * The point of the relay is to let several devices share one line, so the tests are mostly about
 * the things that break when they can't:
 *   - ONE portal session however many devices connect (a second handshake evicts the first)
 *   - fan-out: two devices on one channel is one connection on the line
 *   - the connection budget refuses clearly instead of letting the portal answer 456
 *   - stream ids round-trip, and survive a restart
 *   - "All" (no category_id) returns everything, on live, movies and series
 *   - a dropped live source re-opens without the viewer noticing
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

let ok = true;
function check(label, cond, detail) {
  if (!cond) ok = false;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label.padEnd(56) + (detail == null ? '' : String(detail)));
}

// ---------------------------------------------------------------------------------------------
// Mock portal
// ---------------------------------------------------------------------------------------------
let handshakes = 0;
let createLinks = 0;
let streamOpens = 0;
let dropAfter = 0;          // bytes to serve before hanging up (0 = never)
const CHANNELS = [
  { id: '101', name: 'UK SPORT HD', cmd: 'ffmpeg http://origin/live/101', genre: '1' },
  { id: '102', name: 'UK NEWS HD', cmd: 'ffmpeg http://origin/live/102', genre: '1' },
  { id: '201', name: 'DE FILME', cmd: 'ffmpeg http://origin/live/201', genre: '2' },
];
const MOVIES = [
  { id: '9001', name: 'Dune Part Two', cmd: '/media/file_9001.mpg', cat: '10' },
  { id: '9002', name: 'Arrival', cmd: '/media/file_9002.mpg', cat: '11' },
];
const SERIES = [{ id: '8001', name: 'Severance', cmd: '/media/file_8001.mpg', cat: '20' }];

const portal = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://portal');
  const q = u.searchParams;
  const action = q.get('action');
  const type = q.get('type');
  const send = (js) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ js: js }));
  };

  if (action === 'handshake') { handshakes++; return send({ token: 'TOKEN' + handshakes }); }
  if (action === 'get_profile') return send({});
  if (action === 'get_main_info') return send({ phone: '', end_date: '2030-01-01' });

  if (type === 'itv' && action === 'get_genres') {
    return send([{ id: '1', title: 'UK' }, { id: '2', title: 'DE' }]);
  }
  if (type === 'itv' && action === 'get_ordered_list') {
    return send({ total_items: CHANNELS.length, data: CHANNELS.map((c) => ({
      id: c.id, name: c.name, cmd: c.cmd, tv_genre_id: c.genre, number: c.id, logo: '',
    })) });
  }
  if (type === 'vod' && action === 'get_categories') {
    return send([{ id: '10', title: 'NEW RELEASES' }, { id: '11', title: 'SCI-FI' }]);
  }
  if (type === 'series' && action === 'get_categories') {
    return send([{ id: '20', title: 'DRAMA' }]);
  }
  if (action === 'get_ordered_list' && (type === 'vod' || type === 'series')) {
    const cat = q.get('category');
    const src = type === 'series' ? SERIES : MOVIES;
    const list = (!cat || cat === '*') ? src : src.filter((m) => m.cat === cat);
    return send({ total_items: list.length, data: list.map((m) => ({
      id: m.id, name: m.name, cmd: m.cmd, screenshot_uri: '', is_series: type === 'series' ? 1 : 0,
    })) });
  }
  if (action === 'create_link') {
    createLinks++;
    return send({ cmd: 'ffmpeg http://127.0.0.1:' + origin.address().port + '/stream?c=' +
      encodeURIComponent(q.get('cmd') || '') });
  }
  send({});
});

// The media origin the portal points at.
const origin = http.createServer((req, res) => {
  streamOpens++;
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  const chunk = Buffer.alloc(16 * 1024, 7);
  let sent = 0;
  const timer = setInterval(() => {
    if (res.writableEnded) return clearInterval(timer);
    res.write(chunk);
    sent += chunk.length;
    if (dropAfter && sent >= dropAfter) {
      clearInterval(timer);
      res.socket.destroy();           // hang up mid-stream, like a real provider
    }
  }, 10);
  res.on('close', () => clearInterval(timer));
});

// ---------------------------------------------------------------------------------------------

function get(port, p, headers) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: p, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', () => resolve({ status: 0, body: Buffer.alloc(0), headers: {} }));
  });
}

/** Open a stream and read for `ms`, then disconnect — like a device watching briefly. */
function watch(port, p, ms) {
  return new Promise((resolve) => {
    let bytes = 0;
    const req = http.get({ host: '127.0.0.1', port: port, path: p }, (res) => {
      res.on('data', (c) => { bytes += c.length; });
      setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, bytes: bytes }); }, ms);
    });
    req.on('error', () => resolve({ status: 0, bytes: bytes }));
  });
}

const jsonOf = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch (e) { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => portal.listen(0, '127.0.0.1', r));
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  process.env.RELAY_PORT = '0';
  process.env.RELAY_PASSWORD = 'testpass';
  process.env.RELAY_PORTAL = 'http://127.0.0.1:' + portal.address().port + '/c';
  process.env.RELAY_MAC = '00:1A:79:AA:BB:CC';
  process.env.RELAY_MAX_CONNECTIONS = '2';
  process.env.RELAY_PROFILES_FILE = path.join(dir, 'profiles.json');
  process.env.RELAY_STATE_FILE = path.join(dir, 'state.json');
  process.env.RELAY_CONFIG_FILE = path.join(dir, 'config.json');
  // Pinned so the dashboard doesn't generate one and print it into the test output.
  process.env.RELAY_ADMIN_PASSWORD = 'test-admin-password';

  const relay = require('./server');
  // No opts: this listener stands in for the shared dashboard port, where a line is addressed by
  // its MAC. The env vars above are imported into the config store on first load.
  const server = http.createServer((req, res) => relay.handler(req, res, null));
  server.headersTimeout = 0; server.requestTimeout = 0; server.timeout = 0;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const P = server.address().port;
  relay.config.load();
  relay.applyConfig();
  await sleep(300);

  const U = 'username=00%3A1A%3A79%3AAA%3ABB%3ACC&password=testpass';
  const api = (extra) => '/player_api.php?' + U + (extra ? '&' + extra : '');

  console.log('--- one portal session, however many devices ---');
  handshakes = 0;
  await Promise.all([get(P, api('action=get_live_categories')), get(P, api('action=get_live_categories')),
    get(P, api('action=get_vod_categories')), get(P, api('action=get_series_categories'))]);
  check('4 concurrent device requests, 0 extra handshakes', handshakes === 0,
    'handshakes during requests: ' + handshakes);

  console.log('\n--- "All" returns everything ---');
  const live = jsonOf(await get(P, api('action=get_live_streams')));
  check('live: no category_id -> all channels', Array.isArray(live) && live.length === 3, live && live.length);
  const movies = jsonOf(await get(P, api('action=get_vod_streams')));
  check('movies: no category_id -> all films', Array.isArray(movies) && movies.length === 2, movies && movies.length);
  const series = jsonOf(await get(P, api('action=get_series')));
  check('series: no category_id -> all shows', Array.isArray(series) && series.length === 1, series && series.length);
  const oneCat = jsonOf(await get(P, api('action=get_vod_streams&category_id=11')));
  check('a specific category still filters', oneCat && oneCat.length === 1, oneCat && oneCat.length);

  console.log('\n--- stream ids round-trip ---');
  const ids = live.map((c) => c.stream_id);
  check('every channel has an id', ids.every((i) => Number.isInteger(i) && i > 0), ids.join(','));
  check('ids are unique', new Set(ids).size === ids.length);
  const filtered = jsonOf(await get(P, api('action=get_live_streams&category_id=2')));
  const deId = filtered[0].stream_id;
  const sameInAll = live.find((c) => c.name === filtered[0].name).stream_id;
  check('id is the same in a category listing as in All', deId === sameInAll, deId + ' vs ' + sameInAll);

  console.log('\n--- fan-out: two devices, one connection ---');
  dropAfter = 0;
  streamOpens = 0; createLinks = 0;
  const [a, b] = await Promise.all([
    watch(P, '/live/00%3A1A%3A79%3AAA%3ABB%3ACC/testpass/' + ids[0] + '.ts', 700),
    (async () => { await sleep(150); return watch(P, '/live/00%3A1A%3A79%3AAA%3ABB%3ACC/testpass/' + ids[0] + '.ts', 550); })(),
  ]);
  check('both devices received video', a.bytes > 0 && b.bytes > 0, a.bytes + ' / ' + b.bytes);
  check('only ONE upstream connection was opened', streamOpens === 1, 'opens: ' + streamOpens);
  check('only ONE portal link was created', createLinks === 1, 'create_link: ' + createLinks);

  console.log('\n--- the connection budget refuses clearly ---');
  await sleep(9000);                       // let the lingering lease expire
  streamOpens = 0;
  const holds = [
    watch(P, '/live/00%3A1A%3A79%3AAA%3ABB%3ACC/testpass/' + ids[0] + '.ts', 2500),
    (async () => { await sleep(100); return watch(P, '/live/00%3A1A%3A79%3AAA%3ABB%3ACC/testpass/' + ids[1] + '.ts', 2400); })(),
  ];
  await sleep(600);
  const third = await get(P, '/live/00%3A1A%3A79%3AAA%3ABB%3ACC/testpass/' + ids[2] + '.ts');
  check('third distinct channel is refused', third.status === 503, 'status ' + third.status);
  check('with a message a human can act on', /connections on this line are in use/i.test(third.body.toString()),
    third.body.toString().slice(0, 70));
  await Promise.all(holds);

  console.log('\n--- a dropped live source re-opens invisibly ---');
  await sleep(9000);
  dropAfter = 64 * 1024;                   // hang up after 64 KB, repeatedly
  streamOpens = 0;
  const dropped = await watch(P, '/live/00%3A1A%3A79%3AAA%3ABB%3ACC/testpass/' + ids[0] + '.ts', 2000);
  check('viewer kept receiving through the drops', dropped.bytes > 128 * 1024, dropped.bytes + ' bytes');
  check('the relay re-opened upstream', streamOpens > 1, 'opens: ' + streamOpens);
  dropAfter = 0;

  console.log('\n--- unauthorised access ---');
  const bad = jsonOf(await get(P, '/player_api.php?username=00%3A1A%3A79%3AAA%3ABB%3ACC&password=wrong'));
  check('wrong password is rejected', bad && bad.user_info && bad.user_info.auth === 0);
  const noUser = await get(P, '/live/00%3A00%3A00%3A00%3A00%3A00/testpass/1.ts');
  check('unknown MAC is rejected', noUser.status === 401, 'status ' + noUser.status);

  console.log('\n--- playlist and status ---');
  const m3u = await get(P, '/get.php?' + U);
  const text = m3u.body.toString();
  check('M3U served', text.indexOf('#EXTM3U') === 0);
  check('M3U lists every channel', (text.match(/#EXTINF/g) || []).length === 3);
  check('M3U points back at the relay', text.indexOf('/live/') > 0);
  const st = jsonOf(await get(P, '/status'));
  check('status reports the profile', st && st.profiles && st.profiles.length === 1);
  check('status shows it is connected', st.profiles[0].connected === true);

  console.log('\n--- ids survive a restart ---');
  relay.pool.list().forEach((s) => { /* force a save */ });
  const before = ids.slice().sort().join(',');
  // Re-hydrate a fresh catalogue from the persisted state.
  const { Catalog } = require('./catalog');
  const sess = relay.pool.list()[0];
  const saved = sess.catalog.dehydrate();
  const fresh = new Catalog(sess);
  fresh.hydrate(saved);
  const rehydrated = live.map((c) => {
    const e = fresh.resolve(c.stream_id);
    return e ? e.name : null;
  });
  check('every id still resolves after reload', rehydrated.every((n) => !!n), rehydrated.join(' | '));
  check('and to the same channels', rehydrated.join(',') === live.map((c) => c.name).join(','));
  check('ids unchanged', before === ids.slice().sort().join(','));

  server.close();
  portal.close();
  origin.close();
  relay.pool.stopAll();
  console.log(ok ? '\nALL_PASS' : '\nSOME_FAILED');
  process.exit(ok ? 0 : 1);
})();
