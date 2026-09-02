'use strict';
/**
 * The channel / movie / series catalogue for a session, and the IDs devices use to ask for them.
 *
 * TWO RULES LEARNED THE HARD WAY
 *
 * 1. A stream id must be STABLE and must round-trip. Xtream play URLs carry nothing but a number,
 *    so that number is the only way back to a channel. Deriving it from a filtered or per-category
 *    listing means it shifts when anything is hidden and restarts at 1 for a category query — so
 *    asking for stream 17 plays whatever now sits at position 17 of a different list. Here the id
 *    is assigned once per item and stored alongside the portal `cmd` needed to play it.
 *
 * 2. Never guess the play command from the id. Portals name their media in ways you cannot derive
 *    ("/media/file_<id>.mpg" is a guess that fails on plenty of them). The listing already gives
 *    the real cmd for every item; keep it.
 *
 * Everything is cached because a full catalogue costs many portal requests, and a device asks for
 * the whole list every time it opens a section.
 */

const CATS_TTL = 60 * 60 * 1000;      // categories barely change
const LIST_TTL = 10 * 60 * 1000;      // listings change when the provider adds content

// A safety stop, not an expected limit. The walk normally ends because the portal said how many
// items there are, or because a page added nothing new. This only catches a portal that pages
// forever. It was 200, which silently truncated a 12,000-channel line to about 2,800 — the walk
// stopped early and the missing channels looked like the provider simply didn't carry them.
const PAGE_LIMIT = 5000;

// Gap between background page requests. Warming must not compete with someone watching TV: the
// portal is shared, and hammering it is how you get rate-limited or disconnected.
const WARM_GAP_MS = 120;

// How many catalogue pages to fetch at once while the line is idle. The portal serves only
// ~14 items per page, so a big line is hundreds of pages; fetching several in parallel is the
// single biggest speed-up. Kept modest — the portal is shared and rate-limited.
const WARM_CONCURRENCY = 6;

// How long after connecting before warming starts, so the first device request isn't queued behind
// a full catalogue walk.
const WARM_DELAY_MS = 3000;

class Catalog {
  constructor(session) {
    this.session = session;
    this.cache = new Map();           // key -> { at, value }
    this.inflight = new Map();        // key -> Promise   (so one walk serves every caller)

    // id <-> item. `byId` is what playback resolves against, so it must outlive any single listing.
    this.byId = new Map();            // streamId -> { kind, cmd, name, item }
    this.idByKey = new Map();         // kind|cmd -> streamId  (so ids stay stable across refreshes)
    this.nextId = 1;

    // What the dashboard shows while a first walk is running.
    this.progress = { warming: false, done: false, step: '', pages: 0, items: 0, error: null };
    this._warmTimer = null;
    this._stopped = false;
  }

  _get(key, ttl) {
    const hit = this.cache.get(key);
    if (!hit || Date.now() - hit.at > ttl) return null;
    return hit.value;
  }

  /** Cached value regardless of age — the basis of serving stale data instead of blocking. */
  _stale(key) {
    const hit = this.cache.get(key);
    return hit ? hit.value : null;
  }

  _put(key, value) { this.cache.set(key, { at: Date.now(), value: value }); return value; }

  clear() { this.cache.clear(); }

  stop() {
    this._stopped = true;
    if (this._warmTimer) { clearTimeout(this._warmTimer); this._warmTimer = null; }
  }

  /**
   * Run `build` for `key`, but only ever once at a time.
   *
   * Two devices opening the same category simultaneously used to start two identical page walks —
   * double the portal requests for the same bytes, on a connection budget that is already the
   * scarcest thing here.
   *
   * When something cached exists but has expired, the stale copy is returned IMMEDIATELY and the
   * refresh continues in the background. A ten-minute-old channel list is not worth making someone
   * stare at a spinner for; it is worth refreshing quietly.
   */
  _single(key, ttl, build) {
    const fresh = this._get(key, ttl);
    if (fresh) return Promise.resolve(fresh);

    let job = this.inflight.get(key);
    if (!job) {
      job = Promise.resolve()
        .then(build)
        .then((value) => { this._put(key, value); return value; })
        .catch((e) => {
          // A failed refresh must not discard a good previous answer.
          const old = this._stale(key);
          if (old) {
            log(this, 'refresh of ' + key + ' failed (' + ((e && e.message) || e) +
              ') — keeping the previous copy');
            return old;
          }
          throw e;
        })
        .then((v) => { this.inflight.delete(key); return v; },
          (e) => { this.inflight.delete(key); throw e; });
      this.inflight.set(key, job);
    }

    const stale = this._stale(key);
    if (stale) return Promise.resolve(stale);   // serve now, refresh behind
    return job;
  }

  /**
   * Assign (or recall) the id for an item. Keyed by the portal cmd, so the same channel keeps its
   * id across refreshes and restarts — a player that remembers favourites by stream id keeps
   * working, and a play URL issued an hour ago still resolves.
   */
  idFor(kind, item) {
    const cmd = String((item && item.cmd) || '');
    // Stalker series episodes all share the season's cmd, so a cmd-only key collapsed every
    // episode onto one id (byId kept only the last). Append the episode number so each gets its
    // own id; cmd stays clean because createLink resolves against entry.cmd.
    const key = kind + '|' + (cmd || (item && item.id) || (item && item.name) || '')
      + (item && item.seriesEp != null ? '#' + item.seriesEp : '');
    let id = this.idByKey.get(key);
    if (!id) {
      id = this.nextId++;
      this.idByKey.set(key, id);
    }
    // Keep ONLY the fields playback/EPG/episode resolution ever reads back (id, movieId, seriesEp) —
    // never the heavy display strings (description, actors, poster, genre, …). Those already live in
    // the cached listing arrays; holding a second full copy per id here, and re-serialising it on
    // every 60s state save, is what pushed a ~95k-item line past Node's default heap while warming.
    const it = item || {};
    this.byId.set(id, {
      kind: kind, cmd: cmd, name: it.name || '',
      item: { id: it.id, movieId: it.movieId, seriesEp: it.seriesEp },
    });
    return id;
  }

  resolve(streamId) { return this.byId.get(parseInt(streamId, 10)) || null; }

  /** Restore ids from disk so they survive a restart. */
  hydrate(saved) {
    if (!saved) return;
    (saved.ids || []).forEach(([key, id]) => {
      this.idByKey.set(key, id);
      if (id >= this.nextId) this.nextId = id + 1;
    });
    (saved.items || []).forEach((e) => {
      if (e && e.id) this.byId.set(e.id, { kind: e.kind, cmd: e.cmd, name: e.name, item: e.item });
    });
  }

  dehydrate() {
    return {
      ids: Array.from(this.idByKey.entries()),
      items: Array.from(this.byId.entries()).map(([id, v]) => ({
        id: id, kind: v.kind, cmd: v.cmd, name: v.name, item: v.item,
      })),
    };
  }

  // ---- live ------------------------------------------------------------------------------------

  liveCategories() {
    return this._single('cats:live', CATS_TTL,
      () => this.session.client.getLiveGenres().then(dropAll));
  }

  /**
   * Every live channel, with ids assigned. Walked once and cached: a device listing "all channels"
   * must not cost a portal page-walk per request.
   */
  liveChannels() {
    return this._single('live:all', LIST_TTL, () => this._walkLive());
  }

  async _walkLive(onProgress) {
    return this._walkPaged('live', onProgress,
      (page) => this.session.client.getLiveChannels('*', page));
  }

  // How gentle to be right now. While someone is watching TV through this same line, fall back to
  // one page at a time with a pause between pages — the old behaviour — so the walk never competes
  // with a live stream. While the line is idle there is nothing to be polite to, so go full speed:
  // several pages at once and no gap.
  _busy() {
    try { return !!(this.session && this.session.activeConnections > 0); }
    catch (e) { return false; }
  }
  _concurrency() { return this._busy() ? 1 : WARM_CONCURRENCY; }
  _gap() { return this._busy() ? WARM_GAP_MS : 0; }

  /**
   * Walk a paginated portal listing into a single de-duplicated array, assigning a stable id to
   * every item. `fetchPage(page)` resolves to { items, total, perPage }.
   *
   * The portal serves only ~14 items per page, so a large line is hundreds of pages. Page 1 is
   * fetched on its own because it reports `total` — once we know how many pages exist we fan the
   * rest out `_concurrency()` at a time instead of walking them strictly one after another. Pages
   * are still DRAINED in page order, so ids are assigned in the same deterministic sequence a
   * sequential walk would have used and stay stable across refreshes.
   *
   * If the portal doesn't report a usable total we can't know where the end is, so we fall back to
   * the safe sequential walk that stops when a page adds nothing new.
   */
  async _walkPaged(kind, onProgress, fetchPage) {
    const out = [];
    const seen = new Set();
    const absorb = (items) => {
      let added = 0;
      (items || []).forEach((it) => {
        // Portals repeat entries across pages; without this the list grows but never completes.
        const k = String(it.id || '') + '|' + String(it.cmd || '');
        if (seen.has(k)) return;
        seen.add(k);
        it.streamId = this.idFor(kind, it);
        out.push(it);
        added++;
      });
      return added;
    };

    // Page 1 first — it reports the total, and therefore how many pages exist.
    const first = await fetchPage(1);
    const firstItems = (first && first.items) || [];
    if (!firstItems.length) return out;
    absorb(firstItems);
    if (onProgress) onProgress(1, out.length);

    const total = (first && first.total) || 0;
    const perPage = (first && first.perPage) || firstItems.length;
    if (total && out.length >= total) return out;

    if (total && perPage) {
      const lastPage = Math.min(Math.ceil(total / perPage), PAGE_LIMIT);
      for (let start = 2; start <= lastPage; start += this._concurrency()) {
        if (this._stopped) break;
        const width = this._concurrency();
        const batch = [];
        for (let p = start; p < start + width && p <= lastPage; p++) {
          batch.push(fetchPage(p).then((r) => ({ p: p, r: r }), () => ({ p: p, r: null })));
        }
        const results = (await Promise.all(batch)).sort((a, b) => a.p - b.p);
        for (let i = 0; i < results.length; i++) {
          absorb((results[i].r && results[i].r.items) || []);
        }
        if (onProgress) onProgress(Math.min(start + width - 1, lastPage), out.length);
        const gap = this._gap();
        if (gap) await sleep(gap);
      }
      return out;
    }

    // Portal gave no usable total: walk sequentially until a page adds nothing new.
    for (let page = 2; page <= PAGE_LIMIT; page++) {
      if (this._stopped) break;
      const r = await fetchPage(page);
      const items = (r && r.items) || [];
      if (!items.length) break;
      if (!absorb(items)) break;               // a page adding nothing new is the real end
      if (onProgress) onProgress(page, out.length);
      const gap = this._gap();
      if (gap) await sleep(gap);
    }
    return out;
  }

  // ---- vod / series ---------------------------------------------------------------------------

  vodCategories() {
    return this._single('cats:vod', CATS_TTL,
      () => this.session.client.getVodCategories().then(dropAll));
  }

  seriesCategories() {
    return this._single('cats:series', CATS_TTL,
      () => this.session.client.getSeriesCategories().then(dropAll));
  }

  /**
   * Movies or series in a category. An EMPTY category means everything — that is what an Xtream
   * client sends for "All", and refusing it is what made stalkerhek's Movies and Series look empty.
   */
  list(kind, category) {
    const cat = category && category !== '*' ? String(category) : '*';
    return this._single(kind + ':' + cat, LIST_TTL, () => this._walkList(kind, cat));
  }

  async _walkList(kind, cat, onProgress) {
    return this._walkPaged(kind, onProgress, (page) => (kind === 'series'
      ? this.session.client.getSeriesList(cat, page, '', 'added')
      : this.session.client.getVodList(cat, page, '', 'added')));
  }

  // ---- warming --------------------------------------------------------------------------------

  /**
   * Build the whole catalogue in the background, so no device ever pays for the page walk.
   *
   * This is the difference the relay can make that a plain proxy cannot: Xtream has no pagination,
   * so a client asking for a category expects the entire list in one response. Walking 800 portal
   * pages while a player waits is why some categories took a minute to open. Doing it here, once,
   * ahead of time, means the answer is already in memory when the request arrives.
   *
   * Deliberately sequential and paced. The portal is a shared, rate-limited resource and someone
   * may be watching TV through it while this runs.
   */
  warmSoon() {
    if (this._warmTimer || this.progress.warming) return;
    this._warmTimer = setTimeout(() => {
      this._warmTimer = null;
      this.warm().catch(() => {});
    }, WARM_DELAY_MS);
    if (this._warmTimer.unref) this._warmTimer.unref();
  }

  async warm() {
    if (this.progress.warming || this._stopped) return;
    this.progress = { warming: true, done: false, step: 'starting', pages: 0, items: 0, error: null };
    const started = Date.now();

    const step = (name) => { this.progress.step = name; };
    const onProgress = (pages, items) => {
      this.progress.pages = pages;
      this.progress.items = items;
    };

    try {
      step('categories');
      await this.liveCategories().catch(() => []);
      await this.vodCategories().catch(() => []);
      await this.seriesCategories().catch(() => []);

      // Live first: it is what someone opens the app to watch.
      step('live channels');
      if (!this._get('live:all', LIST_TTL)) {
        const live = await this._walkLive(onProgress);
        this._put('live:all', live);
        log(this, 'warmed ' + live.length + ' live channels');
      }

      step('films');
      if (!this._get('vod:*', LIST_TTL)) {
        const vod = await this._walkList('vod', '*', onProgress);
        this._put('vod:*', vod);
        log(this, 'warmed ' + vod.length + ' films');
      }

      step('series');
      if (!this._get('series:*', LIST_TTL)) {
        const series = await this._walkList('series', '*', onProgress);
        this._put('series:*', series);
        log(this, 'warmed ' + series.length + ' series');
      }

      this.progress.done = true;
      this.progress.step = 'ready';
      log(this, 'catalogue ready in ' + Math.round((Date.now() - started) / 1000) + 's');
    } catch (e) {
      this.progress.error = (e && e.message) || String(e);
      log(this, 'warming stopped: ' + this.progress.error);
    } finally {
      this.progress.warming = false;
    }
  }

  /** Everything worth writing to disk so a restart doesn't re-walk the portal. */
  dumpLists() {
    const out = {};
    ['live:all', 'vod:*', 'series:*', 'cats:live', 'cats:vod', 'cats:series'].forEach((k) => {
      const hit = this.cache.get(k);
      if (hit) out[k] = { at: hit.at, value: hit.value };
    });
    return out;
  }

  loadLists(saved) {
    if (!saved) return 0;
    let n = 0;
    Object.keys(saved).forEach((k) => {
      const e = saved[k];
      if (!e || !e.value) return;
      // Keep the original timestamp: restoring a day-old catalogue as "fresh" would hide new
      // content indefinitely. Stale-while-revalidate serves it instantly and refreshes behind.
      this.cache.set(k, { at: e.at || 0, value: e.value });
      n++;
    });
    if (n) this.progress.step = 'restored from disk';
    return n;
  }

  /** Seasons and episodes for a series, with an id per episode so it can be played. */
  async episodes(seriesId) {
    const key = 'eps:' + seriesId;
    const hit = this._get(key, LIST_TTL);
    if (hit) return hit;

    const entry = this.resolve(seriesId);
    if (!entry) return this._put(key, { seasons: [], episodes: {} });

    const movieId = (entry.item && (entry.item.id || entry.item.movieId)) || seriesId;
    const seasonsRes = await this.session.client.getSeriesEpisodes(movieId, 0);
    const seasonItems = (seasonsRes && seasonsRes.items) || [];

    const seasons = [];
    const episodes = {};

    // A Stalker "season" carries an array of episode NUMBERS; an episode is played with the
    // season's cmd plus that number, not with a cmd of its own. _vodParse exposes that array as
    // `.episodes` (and `.seasons`); the raw portal field is `.series`. Reading only `.series` here
    // meant nums was always empty, so episodes fell to the id-less branch and create_link got no
    // `series` param — the portal then returned `/series/.../.` (no episode) and the edge 403'd.
    for (let i = 0; i < seasonItems.length; i++) {
      const s = seasonItems[i];
      const num = seasonNumber(s.name, i + 1);
      const eps = [];
      const nums = Array.isArray(s.episodes) ? s.episodes
        : (Array.isArray(s.series) ? s.series : []);

      if (nums.length) {
        nums.forEach((n) => {
          const ep = {
            id: this.idFor('episode', { cmd: s.cmd, id: s.id, name: s.name, seriesEp: n }),
            episodeNum: n,
            title: (entry.name || s.name || '') + ' S' + num + 'E' + n,
            container: 'mp4',
          };
          eps.push(ep);
        });
      } else {
        // Some portals expose episodes as their own items instead.
        const r = await this.session.client.getSeriesEpisodes(s.id, s.id).catch(() => null);
        ((r && r.items) || []).forEach((e, idx) => {
          eps.push({
            id: this.idFor('episode', e),
            episodeNum: idx + 1,
            title: e.name || '',
            container: 'mp4',
          });
        });
      }

      seasons.push({ number: num, name: s.name || ('Season ' + num), cover: s.poster || '' });
      episodes[String(num)] = eps;
    }
    return this._put(key, { seasons: seasons, episodes: episodes });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function log(cat, msg) {
  try { console.log('[catalog ' + ((cat.session && cat.session.id) || '?') + '] ' + msg); }
  catch (e) {}
}

function dropAll(list) {
  // Portals often include their own "All" pseudo-category; the façade adds its own.
  return (list || []).filter((c) => {
    const id = String(c.id || '').trim();
    const t = String(c.title || '').trim().toLowerCase();
    return id !== '*' && id !== '0' && t !== 'all';
  });
}

function seasonNumber(name, fallback) {
  const m = /(?:season|s)\s*0*(\d{1,3})/i.exec(String(name || ''));
  return m ? parseInt(m[1], 10) : fallback;
}

module.exports = { Catalog };
