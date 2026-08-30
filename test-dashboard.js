'use strict';
/**
 * Tests for the dashboard, the admin API and per-line ports.
 *
 * Runs the real server against a mock portal. What it is actually checking:
 *   - the management API cannot be reached without signing in
 *   - a line added through the API starts serving, and one deleted stops
 *   - a line's own port serves that line and NOTHING else — in particular no admin API
 *   - each line's password is its own; one line's password must not open another
 *   - moving a port moves the listener; removing it closes the listener
 *   - credentials never appear on an unauthenticated endpoint
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dash-'));
process.env.RELAY_CONFIG_FILE = path.join(TMP, 'config.json');
process.env.RELAY_STATE_FILE = path.join(TMP, 'state.json');
process.env.RELAY_PROFILES_FILE = path.join(TMP, 'nope.json');
process.env.RELAY_ADMIN_PASSWORD = 'dashboard-secret';
process.env.RELAY_PORT_MIN = '14701';
process.env.RELAY_PORT_MAX = '14720';
delete process.env.RELAY_PORTAL;
delete process.env.RELAY_MAC;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

// ---- mock portal -----------------------------------------------------------------------------

let handshakes = 0;
const portal = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://p');
  const action = u.searchParams.get('action');
  const type = u.searchParams.get('type');
  const send = (js) => {
    const b = JSON.stringify({ js: js });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length });
    res.end(b);
  };
  if (action === 'handshake') { handshakes++; return send({ token: 'TOK' + handshakes, random: 'r' }); }
  if (action === 'get_profile' || action === 'get_main_info') {
    return send({ id: 1, status: 1, mac: 'x', phone: '2030-01-01', tariff_plan: 'Full' });
  }
  if (type === 'itv' && action === 'get_genres') {
    return send([{ id: '1', title: 'Sport' }]);
  }
  if (type === 'itv' && action === 'get_ordered_list') {
    return send({ total_items: 1, max_page_items: 14, data: [
      { id: '11', name: 'CH ONE', number: '1', cmd: 'ffmpeg http://x/1', tv_genre_id: '1' },
    ] });
  }
  return send([]);
});

// ---- http helper -----------------------------------------------------------------------------

function req(port, pathname, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: port, path: pathname,
      method: opts.method || 'GET',
      headers: Object.assign(
        opts.body ? { 'Content-Type': 'application/json' } : {},
        opts.cookie ? { Cookie: opts.cookie } : {},
        opts.headers || {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let js = null;
        try { js = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text: text, json: js });
      });
    });
    r.on('error', reject);
    if (opts.body) r.write(JSON.stringify(opts.body));
    r.end();
  });
}

function cookieOf(res) {
  const sc = res.headers['set-cookie'];
  if (!sc || !sc.length) return null;
  return sc[0].split(';')[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- run -------------------------------------------------------------------------------------

(async function main() {
  await new Promise((r) => portal.listen(0, '127.0.0.1', r));
  const PORTAL = 'http://127.0.0.1:' + portal.address().port + '/portal.php';

  const DASH = 14700;
  process.env.RELAY_PORT = String(DASH);
  const server = require('./server');
  server.start();
  await sleep(300);

  console.log('\n--- the management API is closed to strangers ---');
  let r = await req(DASH, '/api/lines');
  ok('listing lines needs a session', r.status === 401, 'status ' + r.status);
  r = await req(DASH, '/api/lines', { method: 'POST', body: { portal: PORTAL, mac: '00:1A:79:00:00:01', password: 'aaaa' } });
  ok('adding a line needs a session', r.status === 401, 'status ' + r.status);
  r = await req(DASH, '/api/login', { method: 'POST', body: { password: 'wrong' } });
  ok('a wrong password is refused', r.status === 401);

  console.log('\n--- signing in ---');
  r = await req(DASH, '/api/login', { method: 'POST', body: { password: 'dashboard-secret' } });
  const cookie = cookieOf(r);
  ok('correct password signs in', r.status === 200 && !!cookie);
  ok('the cookie is HttpOnly', /HttpOnly/i.test((r.headers['set-cookie'] || [''])[0]));
  ok('and SameSite=Strict', /SameSite=Strict/i.test((r.headers['set-cookie'] || [''])[0]));

  console.log('\n--- adding lines ---');
  r = await req(DASH, '/api/lines', {
    method: 'POST', cookie: cookie,
    body: { name: 'Line A', portal: PORTAL, mac: '00:1A:79:00:00:01', password: 'aaaapass', port: 14701, maxConnections: 2 },
  });
  ok('a valid line is accepted', r.status === 200, r.json && r.json.error);
  const lineA = r.json && r.json.line;

  r = await req(DASH, '/api/lines', {
    method: 'POST', cookie: cookie,
    body: { name: 'Line B', portal: PORTAL, mac: '00:1A:79:00:00:02', password: 'bbbbpass', port: 14702, maxConnections: 1 },
  });
  ok('a second line on its own port is accepted', r.status === 200, r.json && r.json.error);
  const lineB = r.json && r.json.line;

  r = await req(DASH, '/api/lines', {
    method: 'POST', cookie: cookie,
    body: { name: 'Clash', portal: PORTAL, mac: '00:1A:79:00:00:03', password: 'ccccpass', port: 14701 },
  });
  ok('a port already in use is refused', r.status === 400 && /already used/i.test(r.json.error), r.json && r.json.error);

  r = await req(DASH, '/api/lines', {
    method: 'POST', cookie: cookie,
    body: { name: 'Dup', portal: PORTAL, mac: '00:1A:79:00:00:01', password: 'ddddpass' },
  });
  ok('the same portal+MAC twice is refused', r.status === 400 && /evict/i.test(r.json.error), r.json && r.json.error);

  r = await req(DASH, '/api/lines', {
    method: 'POST', cookie: cookie,
    body: { name: 'Bad port', portal: PORTAL, mac: '00:1A:79:00:00:04', password: 'eeeepass', port: 22 },
  });
  ok('a port outside the range is refused', r.status === 400 && /between/i.test(r.json.error), r.json && r.json.error);

  r = await req(DASH, '/api/lines', {
    method: 'POST', cookie: cookie,
    body: { name: 'Short', portal: PORTAL, mac: '00:1A:79:00:00:05', password: 'x' },
  });
  ok('a too-short line password is refused', r.status === 400, r.json && r.json.error);

  r = await req(DASH, '/api/lines', {
    method: 'POST', cookie: cookie,
    body: { name: 'Bad mac', portal: PORTAL, mac: 'not-a-mac', password: 'ffffpass' },
  });
  ok('a malformed MAC is refused', r.status === 400 && /12 hex/i.test(r.json.error), r.json && r.json.error);

  await sleep(600);

  console.log('\n--- each line answers on its own port ---');
  r = await req(14701, '/player_api.php?username=anything&password=aaaapass');
  ok('line A answers on 14701', r.status === 200 && r.json && r.json.user_info.auth === 1, 'status ' + r.status);
  r = await req(14702, '/player_api.php?username=anything&password=bbbbpass');
  ok('line B answers on 14702', r.status === 200 && r.json && r.json.user_info.auth === 1, 'status ' + r.status);

  console.log('\n--- one line\'s password does not open another ---');
  r = await req(14702, '/player_api.php?username=anything&password=aaaapass');
  ok('line A password refused on line B', r.status === 401, 'status ' + r.status);
  r = await req(14701, '/player_api.php?username=anything&password=bbbbpass');
  ok('line B password refused on line A', r.status === 401, 'status ' + r.status);

  console.log('\n--- the shared port still addresses lines by MAC ---');
  r = await req(DASH, '/player_api.php?username=00:1A:79:00:00:01&password=aaaapass');
  ok('line A reachable by MAC on the shared port', r.status === 200 && r.json.user_info.auth === 1);
  r = await req(DASH, '/player_api.php?username=00:1A:79:00:00:02&password=aaaapass');
  ok('but not with the wrong line\'s password', r.status === 401);

  console.log('\n--- a line port exposes no management surface ---');
  r = await req(14701, '/api/lines', { cookie: cookie });
  ok('/api/lines is not routed on a line port', r.status === 404, 'status ' + r.status);
  r = await req(14701, '/api/login', { method: 'POST', body: { password: 'dashboard-secret' } });
  ok('/api/login is not routed either', r.status === 404, 'status ' + r.status);
  r = await req(14701, '/');
  ok('the dashboard page is not served there', !/<html/i.test(r.text), r.text.slice(0, 40));

  console.log('\n--- unauthenticated endpoints leak no credentials ---');
  r = await req(DASH, '/status');
  const body = r.text;
  ok('/status has no MAC', body.indexOf('00:1A:79') < 0);
  ok('/status has no portal URL', body.indexOf('127.0.0.1:' + portal.address().port) < 0);
  ok('/status has no password', body.indexOf('aaaapass') < 0);
  r = await req(14701, '/status');
  ok('a line port\'s status is scoped to that line', r.json && r.json.profiles.length === 1,
    'profiles: ' + (r.json && r.json.profiles.length));

  console.log('\n--- the EPG endpoint checks the password ---');
  r = await req(DASH, '/xmltv.php?username=00:1A:79:00:00:01');
  ok('no password is refused', r.status === 401, 'status ' + r.status);
  r = await req(DASH, '/xmltv.php?username=00:1A:79:00:00:01&password=wrong');
  ok('a wrong password is refused', r.status === 401, 'status ' + r.status);

  console.log('\n--- moving a port moves the listener ---');
  r = await req(DASH, '/api/lines/' + lineB.id, {
    method: 'PUT', cookie: cookie,
    body: Object.assign({}, lineB, { port: 14703 }),
  });
  ok('the port change is accepted', r.status === 200, r.json && r.json.error);
  await sleep(500);
  r = await req(14703, '/player_api.php?username=x&password=bbbbpass');
  ok('line B now answers on 14703', r.status === 200 && r.json.user_info.auth === 1, 'status ' + r.status);
  let refused = false;
  try { await req(14702, '/player_api.php?username=x&password=bbbbpass'); }
  catch (e) { refused = (e.code === 'ECONNREFUSED'); }
  ok('and 14702 is closed', refused);

  console.log('\n--- clearing the port falls back to the shared one ---');
  r = await req(DASH, '/api/lines/' + lineB.id, {
    method: 'PUT', cookie: cookie,
    body: Object.assign({}, lineB, { port: '' }),
  });
  ok('clearing the port is accepted', r.status === 200, r.json && r.json.error);
  await sleep(500);
  refused = false;
  try { await req(14703, '/player_api.php?username=x&password=bbbbpass'); }
  catch (e) { refused = (e.code === 'ECONNREFUSED'); }
  ok('14703 is closed', refused);
  r = await req(DASH, '/player_api.php?username=00:1A:79:00:00:02&password=bbbbpass');
  ok('line B still reachable by MAC', r.status === 200 && r.json.user_info.auth === 1);

  console.log('\n--- config survives a reload ---');
  const onDisk = JSON.parse(fs.readFileSync(process.env.RELAY_CONFIG_FILE, 'utf8'));
  ok('lines were persisted', onDisk.lines.length === 2, onDisk.lines.length + ' line(s)');
  ok('the admin password is hashed, not stored', !JSON.stringify(onDisk.admin).includes('dashboard-secret'));

  console.log('\n--- disabling a line stops it serving ---');
  r = await req(DASH, '/api/lines/' + lineA.id, {
    method: 'PUT', cookie: cookie,
    body: Object.assign({}, lineA, { enabled: false }),
  });
  ok('disable accepted', r.status === 200, r.json && r.json.error);
  await sleep(400);
  r = await req(DASH, '/player_api.php?username=00:1A:79:00:00:01&password=aaaapass');
  ok('a disabled line refuses players', r.status === 401, 'status ' + r.status);
  refused = false;
  try { await req(14701, '/player_api.php?username=x&password=aaaapass'); }
  catch (e) { refused = (e.code === 'ECONNREFUSED'); }
  ok('and its port is closed', refused);

  console.log('\n--- deleting ---');
  r = await req(DASH, '/api/lines/' + lineA.id, { method: 'DELETE', cookie: cookie });
  ok('delete accepted', r.status === 200);
  r = await req(DASH, '/api/lines', { cookie: cookie });
  ok('one line remains', r.json.lines.length === 1, r.json.lines.length + '');

  console.log('\n--- signing out ---');
  r = await req(DASH, '/api/logout', { method: 'POST', cookie: cookie });
  ok('logout accepted', r.status === 200);
  r = await req(DASH, '/api/lines', { cookie: cookie });
  ok('the old cookie no longer works', r.status === 401, 'status ' + r.status);

  console.log('\n--- the dashboard page itself ---');
  r = await req(DASH, '/');
  ok('the page is served', r.status === 200 && /<html/i.test(r.text));
  ok('with a content security policy', !!r.headers['content-security-policy']);
  ok('and is not cached', /no-store/.test(r.headers['cache-control'] || ''));
  ok('the page contains no credentials', r.text.indexOf('aaaapass') < 0 && r.text.indexOf('dashboard-secret') < 0);

  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL_PASS ' + pass + ' checks'));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('test harness error: ' + (e && e.stack || e));
  process.exit(1);
});
