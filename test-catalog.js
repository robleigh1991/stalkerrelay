'use strict';
/**
 * Tests for building the catalogue on the relay instead of making devices wait for it.
 *
 * The mock portal here is deliberately BIG and SLOW — 3,000 channels at 14 per page is 215
 * sequential requests. That is the shape of the real problem: Xtream has no pagination, so a client
 * asking for a category expects everything at once, and walking the portal while it waits is what
 * made categories take a minute to open.
 *
 * What's being checked:
 *   - a large catalogue is walked completely, not truncated by a page cap
 *   - concurrent requests cause ONE walk, not one each
 *   - once warm, a request is served from memory
 *   - an expired cache serves the stale copy immediately and refreshes behind
 *   - a failed refresh keeps the previous copy rather than throwing it away
 *   - the catalogue survives a restart without re-walking the portal
 */
const { Catalog } = require('./catalog');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + pad(name) + (detail != null ? '  ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + pad(name) + (detail != null ? '  ' + detail : '')); }
}
function pad(s) { return s.length >= 54 ? s : s + ' '.repeat(54 - s.length); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a big, slow, realistic portal -----------------------------------------------------------

const PAGE_SIZE = 14;
const TOTAL_CHANNELS = 3000;

function makeClient(opts) {
  opts = opts || {};
  const c = {
    pageRequests: 0,
    genreRequests: 0,
    failLive: false,
    async getLiveGenres() { c.genreRequests++; return [{ id: '1', title: 'Sport' }]; },
    async getVodCategories() { return [{ id: '10', title: 'Films' }]; },
    async getSeriesCategories() { return [{ id: '20', title: 'Shows' }]; },
    async getLiveChannels(genre, page) {
      c.pageRequests++;
      if (c.failLive) throw new Error('portal went away');
      if (opts.latency) await sleep(opts.latency);
      const start = (page - 1) * PAGE_SIZE;
      if (start >= TOTAL_CHANNELS) return { total: TOTAL_CHANNELS, items: [] };
      const items = [];
      for (let i = start; i < Math.min(start + PAGE_SIZE, TOTAL_CHANNELS); i++) {
        items.push({ id: String(i + 1), name: 'CH ' + (i + 1), cmd: 'ffmpeg http://x/' + (i + 1), tv_genre_id: '1' });
      }
      return { total: TOTAL_CHANNELS, items: items };
    },
    async getVodList(cat, page) {
      c.pageRequests++;
      if (page > 2) return { total: 20, items: [] };
      const items = [];
      for (let i = 0; i < 10; i++) {
        const n = (page - 1) * 10 + i + 1;
        items.push({ id: 'v' + n, name: 'Film ' + n, cmd: '/media/v' + n + '.mpg', category_id: '10' });
      }
      return { total: 20, items: items };
    },
    async getSeriesList(cat, page) {
      c.pageRequests++;
      if (page > 1) return { total: 2, items: [] };
      return { total: 2, items: [
        { id: 's1', name: 'Show One', cmd: '/media/s1', category_id: '20' },
        { id: 's2', name: 'Show Two', cmd: '/media/s2', category_id: '20' },
      ] };
    },
  };
  return c;
}

function makeSession(client) {
  return { id: 'test', name: 'Test line', client: client, cfg: {} };
}

// ---- run -------------------------------------------------------------------------------------

(async function main() {
  console.log('--- a large catalogue is walked completely ---');
  {
    const client = makeClient();
    const cat = new Catalog(makeSession(client));
    const live = await cat.liveChannels();
    ok('all 3000 channels, not truncated', live.length === TOTAL_CHANNELS, live.length + ' channels');
    ok('which took the expected page walk', client.pageRequests >= TOTAL_CHANNELS / PAGE_SIZE,
      client.pageRequests + ' portal requests');
    ok('every channel got an id', live.every((c) => c.streamId > 0));
    const ids = new Set(live.map((c) => c.streamId));
    ok('ids are unique', ids.size === live.length, ids.size + ' unique');
  }

  console.log('\n--- concurrent callers share ONE walk ---');
  {
    const client = makeClient({ latency: 1 });
    const cat = new Catalog(makeSession(client));
    const [a, b, c, d] = await Promise.all([
      cat.liveChannels(), cat.liveChannels(), cat.liveChannels(), cat.liveChannels(),
    ]);
    const expected = Math.ceil(TOTAL_CHANNELS / PAGE_SIZE);
    ok('four callers, one walk', client.pageRequests <= expected + 1,
      client.pageRequests + ' requests (one walk is ' + expected + ')');
    ok('and they all got the full list',
      a.length === TOTAL_CHANNELS && b.length === a.length && c.length === a.length && d.length === a.length);
    ok('and literally the same array', a === b && b === c);
  }

  console.log('\n--- once warm, no portal requests at all ---');
  {
    const client = makeClient();
    const cat = new Catalog(makeSession(client));
    await cat.liveChannels();
    const after = client.pageRequests;
    const t0 = Date.now();
    const again = await cat.liveChannels();
    ok('served from memory', client.pageRequests === after, 'extra requests: ' + (client.pageRequests - after));
    ok('and immediately', Date.now() - t0 < 20, (Date.now() - t0) + 'ms');
    ok('with everything still there', again.length === TOTAL_CHANNELS);
  }

  console.log('\n--- an expired cache serves stale immediately, refreshes behind ---');
  {
    const client = makeClient();
    const cat = new Catalog(makeSession(client));
    await cat.liveChannels();
    const afterFirst = client.pageRequests;

    // Age the entry past its TTL.
    cat.cache.get('live:all').at = Date.now() - (11 * 60 * 1000);

    const t0 = Date.now();
    const stale = await cat.liveChannels();
    const elapsed = Date.now() - t0;
    ok('the caller was not made to wait', elapsed < 20, elapsed + 'ms');
    ok('and still got a full list', stale.length === TOTAL_CHANNELS, stale.length + '');
    await sleep(60);
    ok('while a refresh started behind it', client.pageRequests > afterFirst,
      (client.pageRequests - afterFirst) + ' new requests');
  }

  console.log('\n--- a failed refresh keeps the previous copy ---');
  {
    const client = makeClient();
    const cat = new Catalog(makeSession(client));
    await cat.liveChannels();
    cat.cache.get('live:all').at = 0;      // force expiry
    client.failLive = true;

    const first = await cat.liveChannels();     // stale, served instantly
    ok('stale copy still served', first.length === TOTAL_CHANNELS);
    await sleep(50);
    const second = await cat.liveChannels();
    ok('and kept after the refresh failed', second.length === TOTAL_CHANNELS, second.length + '');
  }

  console.log('\n--- warming builds everything in the background ---');
  {
    const client = makeClient();
    const cat = new Catalog(makeSession(client));
    ok('nothing cached to begin with', cat.progress.warming === false && !cat.progress.done);
    const p = cat.warm();
    await sleep(30);
    ok('progress is reported while it runs', cat.progress.warming === true, 'step: ' + cat.progress.step);
    await p;
    ok('finished', cat.progress.done === true && cat.progress.warming === false);
    ok('live built', (await cat.liveChannels()).length === TOTAL_CHANNELS);
    ok('films built', (await cat.list('vod', '*')).length === 20);
    ok('series built', (await cat.list('series', '*')).length === 2);
    const before = client.pageRequests;
    await Promise.all([cat.liveChannels(), cat.list('vod', '*'), cat.list('series', '*')]);
    ok('and a device request now costs nothing', client.pageRequests === before,
      'extra requests: ' + (client.pageRequests - before));
  }

  console.log('\n--- the catalogue survives a restart ---');
  {
    const client1 = makeClient();
    const cat1 = new Catalog(makeSession(client1));
    await cat1.warm();
    const dumped = JSON.parse(JSON.stringify(cat1.dumpLists()));
    const ids1 = cat1.dehydrate();

    const client2 = makeClient();
    const cat2 = new Catalog(makeSession(client2));
    cat2.hydrate(JSON.parse(JSON.stringify(ids1)));
    const restored = cat2.loadLists(dumped);
    ok('lists restored from disk', restored >= 3, restored + ' entries');

    const live = await cat2.liveChannels();
    ok('served without touching the portal', client2.pageRequests === 0,
      client2.pageRequests + ' portal requests');
    ok('and it is the whole list', live.length === TOTAL_CHANNELS, live.length + '');

    // Ids must be identical, or every saved favourite in every player breaks.
    const a = (await cat1.liveChannels()).slice(0, 50).map((c) => c.streamId).join(',');
    const b = live.slice(0, 50).map((c) => c.streamId).join(',');
    ok('stream ids are unchanged across the restart', a === b);

    const entry = cat2.resolve(live[10].streamId);
    ok('and still resolve to the right channel', entry && entry.name === live[10].name,
      entry && entry.name);
  }

  console.log('\n--- restored data is still refreshed, not frozen ---');
  {
    const client1 = makeClient();
    const cat1 = new Catalog(makeSession(client1));
    await cat1.liveChannels();
    const dumped = JSON.parse(JSON.stringify(cat1.dumpLists()));
    // Pretend the file is a day old.
    dumped['live:all'].at = Date.now() - 24 * 60 * 60 * 1000;

    const client2 = makeClient();
    const cat2 = new Catalog(makeSession(client2));
    cat2.loadLists(dumped);
    const t0 = Date.now();
    const list = await cat2.liveChannels();
    ok('a day-old list is still served instantly', Date.now() - t0 < 20 && list.length === TOTAL_CHANNELS);
    await sleep(60);
    ok('but a refresh was started', client2.pageRequests > 0, client2.pageRequests + ' requests');
  }

  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'ALL_PASS ' + pass + ' checks'));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('harness error: ' + ((e && e.stack) || e));
  process.exit(1);
});
