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
const PAGE_LIMIT = 200;               // pages to walk before accepting a partial list

class Catalog {
  constructor(session) {
    this.session = session;
    this.cache = new Map();           // key -> { at, value }

    // id <-> item. `byId` is what playback resolves against, so it must outlive any single listing.
    this.byId = new Map();            // streamId -> { kind, cmd, name, item }
    this.idByKey = new Map();         // kind|cmd -> streamId  (so ids stay stable across refreshes)
    this.nextId = 1;
  }

  _get(key, ttl) {
    const hit = this.cache.get(key);
    if (!hit || Date.now() - hit.at > ttl) return null;
    return hit.value;
  }
  _put(key, value) { this.cache.set(key, { at: Date.now(), value: value }); return value; }

  clear() { this.cache.clear(); }

  /**
   * Assign (or recall) the id for an item. Keyed by the portal cmd, so the same channel keeps its
   * id across refreshes and restarts — a player that remembers favourites by stream id keeps
   * working, and a play URL issued an hour ago still resolves.
   */
  idFor(kind, item) {
    const cmd = String((item && item.cmd) || '');
    const key = kind + '|' + (cmd || (item && item.id) || (item && item.name) || '');
    let id = this.idByKey.get(key);
    if (!id) {
      id = this.nextId++;
      this.idByKey.set(key, id);
    }
    this.byId.set(id, { kind: kind, cmd: cmd, name: (item && item.name) || '', item: item });
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

  async liveCategories() {
    const hit = this._get('cats:live', CATS_TTL);
    if (hit) return hit;
    const c = await this.session.client.getLiveGenres();
    return this._put('cats:live', dropAll(c));
  }

  /**
   * Every live channel, with ids assigned. Walked once and cached: a device listing "all channels"
   * must not cost a portal page-walk per request.
   */
  async liveChannels() {
    const hit = this._get('live:all', LIST_TTL);
    if (hit) return hit;
    const out = [];
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const r = await this.session.client.getLiveChannels('*', page);
      const items = (r && r.items) || [];
      if (!items.length) break;
      items.forEach((ch) => {
        ch.streamId = this.idFor('live', ch);
        out.push(ch);
      });
      const total = (r && r.total) || 0;
      if (total && out.length >= total) break;
    }
    return this._put('live:all', out);
  }

  // ---- vod / series ---------------------------------------------------------------------------

  async vodCategories() {
    const hit = this._get('cats:vod', CATS_TTL);
    if (hit) return hit;
    const c = await this.session.client.getVodCategories();
    return this._put('cats:vod', dropAll(c));
  }

  async seriesCategories() {
    const hit = this._get('cats:series', CATS_TTL);
    if (hit) return hit;
    const c = await this.session.client.getSeriesCategories();
    return this._put('cats:series', dropAll(c));
  }

  /**
   * Movies or series in a category. An EMPTY category means everything — that is what an Xtream
   * client sends for "All", and refusing it is what made stalkerhek's Movies and Series look empty.
   */
  async list(kind, category) {
    const cat = category && category !== '*' ? String(category) : '*';
    const key = kind + ':' + cat;
    const hit = this._get(key, LIST_TTL);
    if (hit) return hit;

    const fetchPage = (page) => (kind === 'series'
      ? this.session.client.getSeriesList(cat, page, '', 'added')
      : this.session.client.getVodList(cat, page, '', 'added'));

    const out = [];
    const seen = new Set();
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const r = await fetchPage(page);
      const items = (r && r.items) || [];
      if (!items.length) break;
      let added = 0;
      items.forEach((m) => {
        const k = String(m.id || '') + '|' + String(m.cmd || '');
        if (seen.has(k)) return;          // portals repeat entries across pages
        seen.add(k);
        m.streamId = this.idFor(kind, m);
        out.push(m);
        added++;
      });
      // A page that adds nothing new is the real end, whatever `total` claims.
      if (!added) break;
      const total = (r && r.total) || 0;
      if (total && seen.size >= total) break;
    }
    return this._put(key, out);
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

    // A Stalker "season" carries a `series` array of episode NUMBERS; an episode is played with the
    // season's cmd plus that number, not with a cmd of its own.
    for (let i = 0; i < seasonItems.length; i++) {
      const s = seasonItems[i];
      const num = seasonNumber(s.name, i + 1);
      const eps = [];
      const nums = Array.isArray(s.series) ? s.series : [];

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
