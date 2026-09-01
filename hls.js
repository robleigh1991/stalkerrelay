'use strict';
/**
 * HLS live output — the mobile path.
 *
 * This source hands out live in ~30-second chunks (each play_token = one chunk), and progressive
 * TS-over-HTTP can't bridge a chunk boundary for a strict player: ExoPlayer's live buffer drains in
 * the ~1s re-resolve gap and it reconnects. HLS is exactly the right shape for a chunked source — a
 * rolling playlist of small segments the player fetches with a real buffer, so the seams disappear.
 *
 * One ffmpeg per channel reads the Broadcast (which handles the edge fetch / re-open / token refresh)
 * and writes `-f hls` segments to a temp dir. The relay serves the playlist and segments from there.
 * A session lives while the player keeps polling and is garbage-collected after it goes idle.
 *
 * Desktop is untouched: it keeps requesting `.ts` and gets the raw Broadcast, which it remuxes itself.
 */
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FFMPEG = process.env.RELAY_FFMPEG || 'ffmpeg';
const HLS_ROOT = process.env.RELAY_HLS_DIR || path.join(os.tmpdir(), 'relay-hls');
const IDLE_MS = 30000;          // close a session no one has polled for this long
const PLAYLIST_TIMEOUT_MS = 15000;
const SEG_TIME = 2;             // seconds per segment
const LIST_SIZE = 8;           // segments kept in the live window (~16s)

function log(msg) { try { console.log('[hls] ' + msg); } catch (e) {} }

class HlsSession {
  constructor(key) {
    this.key = key;
    this.broadcast = null;       // = lease.upstream, set by the manager before start()
    this.lease = null;           // the session's connection lease, so HLS shows in "Playing now"
    this.dir = path.join(HLS_ROOT, key.replace(/[^a-zA-Z0-9_-]/g, '_'));
    this.ff = null;
    this.input = null;
    this.closed = false;
    this.lastAccess = Date.now();
    this._starting = null;
    this._restartTimer = null;
    this._restarts = 0;
    this._segBase = 0;   // ffmpeg -start_number; bumped each respawn so seg names never repeat
  }

  playlistPath() { return path.join(this.dir, 'index.m3u8'); }

  start() {
    if (this._starting) return this._starting;
    this._starting = (async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      // The broadcast (lease.upstream) was already started by the lease factory.
      this._spawn();
      await this._waitForPlaylist();
      log('session ready ' + this.key);
      return this;
    })();
    return this._starting;
  }

  _spawn() {
    if (this.closed) return;
    this.input = new PassThrough({ highWaterMark: 8 * 1024 * 1024 });
    this.broadcast.addViewer(this.input);
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', '+genpts+discardcorrupt',
      '-i', 'pipe:0',
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-ar', '48000', '-sn',
      '-f', 'hls',
      '-hls_time', String(SEG_TIME),
      '-hls_list_size', String(LIST_SIZE),
      '-hls_delete_threshold', '1',
      // Continue the segment NUMBER and media-sequence across an ffmpeg respawn (bumped in onExit),
      // so a respawn never reuses seg_0 — a reused name is exactly what the phone had cached and
      // replayed. append_list keeps writing the same rolling playlist rather than resetting it.
      '-start_number', String(this._segBase),
      '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments+program_date_time',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(this.dir, 'seg_%d.ts'),
      this.playlistPath(),
    ];
    let ff;
    try { ff = spawn(FFMPEG, args); }
    catch (e) { log('ffmpeg spawn failed: ' + ((e && e.message) || e)); return this._scheduleRestart(); }
    this.ff = ff;
    this.input.pipe(ff.stdin);
    ff.stdin.on('error', () => {});   // EPIPE when ffmpeg dies mid-write
    ff.stderr.on('data', () => {});
    const onExit = (why) => {
      if (this.closed) return;
      log('ffmpeg exited (' + why + ') for ' + this.key);
      try { this.broadcast.removeViewer(this.input); } catch (e) {}
      this.ff = null;
      // If the source is gone, restarting ffmpeg onto a dead broadcast just produces a static
      // playlist the phone loops forever — close instead, so the next request rebuilds cleanly.
      if (this.broadcast.closed) { log('broadcast gone — closing ' + this.key); return this.close(); }
      this._segBase += 100000;   // continue segment numbers past anything already written
      this._scheduleRestart();
    };
    ff.on('exit', (code) => onExit('code ' + code));
    ff.on('error', (e) => onExit((e && e.code) || 'error'));
  }

  _scheduleRestart() {
    if (this.closed || this._restartTimer) return;
    this._restarts++;
    if (this._restarts > 12) { log('giving up after ' + this._restarts + ' ffmpeg restarts ' + this.key); return this.close(); }
    this._restartTimer = setTimeout(() => { this._restartTimer = null; if (!this.closed) this._spawn(); }, Math.min(500 * this._restarts, 5000));
  }

  _waitForPlaylist() {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.closed) return reject(new Error('session closed'));
        if (fs.existsSync(this.playlistPath())) return resolve();
        if (Date.now() - started > PLAYLIST_TIMEOUT_MS) return reject(new Error('HLS playlist did not appear'));
        setTimeout(check, 200);
      };
      check();
    });
  }

  touch() { this.lastAccess = Date.now(); if (this._restarts) this._restarts = 0; }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    log('closing ' + this.key);
    if (this.ff) { try { this.ff.kill('SIGKILL'); } catch (e) {} this.ff = null; }
    try { if (this.input) this.input.end(); } catch (e) {}
    // Release the lease (its linger closes the broadcast) so the channel leaves "Playing now" and
    // frees the connection slot. Fall back to closing the broadcast directly if there's no lease.
    try { if (this.lease) this.lease.release(); else if (this.broadcast) this.broadcast.close(); } catch (e) {}
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (e) {}
  }
}

class HlsManager {
  constructor() {
    this.sessions = new Map();
    try { fs.rmSync(HLS_ROOT, { recursive: true, force: true }); } catch (e) {}   // clear stale dirs on boot
    this._gc = setInterval(() => this._sweep(), 10000);
    if (this._gc.unref) this._gc.unref();
  }

  /** makeLease: async () => a started lease ({ upstream: Broadcast, release }). Called only on create. */
  async get(key, makeLease) {
    let s = this.sessions.get(key);
    if (s) { s.touch(); if (s._starting) { try { await s._starting; } catch (e) { /* fall through to recreate below */ } } if (!s.closed) return s; }
    s = new HlsSession(key);
    this.sessions.set(key, s);
    try {
      s.lease = await makeLease();
      s.broadcast = s.lease.upstream;
      await s.start();
    } catch (e) {
      this.sessions.delete(key);
      s.close();
      throw e;
    }
    return s;
  }

  peek(key) { const s = this.sessions.get(key); if (s) s.touch(); return (s && !s.closed) ? s : null; }

  _sweep() {
    const now = Date.now();
    for (const [k, s] of Array.from(this.sessions.entries())) {
      if (now - s.lastAccess > IDLE_MS) { this.sessions.delete(k); s.close(); }
    }
  }

  stopAll() { for (const s of this.sessions.values()) s.close(); this.sessions.clear(); }
}

module.exports = { HlsManager, HLS_ROOT };
