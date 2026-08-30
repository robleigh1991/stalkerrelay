'use strict';
/**
 * Dependency-free SOCKS5 (and SOCKS4a) support as Node http/https Agents.
 * Used to route the local stream proxy's upstream fetches — and the Stalker portal
 * API — through a SOCKS proxy, so the provider sees the proxy's IP (e.g. a residential
 * or different-country exit) instead of the user's real one. DNS is resolved at the
 * proxy (domain address type), so there's no local DNS leak (socks5h behaviour).
 *
 * Supported proxy URL forms:
 *   socks5://host:port
 *   socks5://user:pass@host:port
 *   socks4://host:port         (uses SOCKS4a, remote DNS)
 */
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ---- SOCKS5 CONNECT: open a TCP tunnel to host:port through the proxy ----
function socks5Connect(proxy, host, port, cb) {
  let done = false;
  const socket = net.connect(proxy.port, proxy.host);
  const onErr = (e) => finish(e);
  const onTimeout = () => { socket.destroy(); finish(new Error('SOCKS proxy timeout')); };
  // On success we hand the socket to Node's HTTP agent, so our own listeners must come off —
  // otherwise a later ECONNRESET is swallowed here instead of reaching the HTTP client, and the
  // request just hangs until the upstream timeout.
  const finish = (err, sock) => {
    if (done) return;
    done = true;
    socket.removeListener('error', onErr);
    socket.removeListener('timeout', onTimeout);
    socket.removeListener('data', onData);
    if (!err) socket.setTimeout(0);
    cb(err, sock);
  };
  socket.setTimeout(15000);
  socket.on('timeout', onTimeout);
  socket.on('error', onErr);

  let stage = 'greet';
  let buf = Buffer.alloc(0);
  socket.on('connect', () => {
    const methods = proxy.user ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length].concat(methods)));
  });

  // TCP gives no message boundaries: replies can arrive split or coalesced, so buffer and only
  // parse once a complete reply for the current stage is present.
  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail('bad SOCKS version from proxy');
        const method = buf[1];
        buf = buf.slice(2);
        if (method === 0xff) return fail('proxy rejected auth methods');
        if (method === 0x02) {
          if (!proxy.user) return fail('proxy requires username/password');
          const u = Buffer.from(proxy.user, 'utf8');
          const p = Buffer.from(proxy.pass || '', 'utf8');
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          stage = 'auth';
        } else {
          sendConnect(); stage = 'reply';
        }
        continue;
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ok = buf[1] === 0x00;
        buf = buf.slice(2);
        if (!ok) return fail('SOCKS username/password rejected');
        sendConnect(); stage = 'reply';
        continue;
      }
      if (stage === 'reply') {
        if (buf.length < 5) return;
        if (buf[0] !== 0x05) return fail('bad SOCKS reply');
        if (buf[1] !== 0x00) return fail('SOCKS connect failed (code ' + buf[1] + ')');
        // Reply length depends on the bound-address type.
        const atyp = buf[3];
        const len = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? (7 + buf[4]) : 0;
        if (!len) return fail('bad SOCKS address type');
        if (buf.length < len) return;
        const rest = buf.slice(len);
        if (rest.length) socket.unshift(rest);   // any early payload belongs to the tunnel
        return finish(null, socket);
      }
      return;
    }
  }
  socket.on('data', onData);

function sendConnect() {
    const h = Buffer.from(host, 'utf8');
    const head = Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]);
    const tail = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
    socket.write(Buffer.concat([head, h, tail]));   // ver,cmd,rsv,atyp,len + HOST + port
  }
  function fail(msg) { socket.destroy(); finish(new Error(msg)); }
}

// ---- SOCKS4a CONNECT (remote DNS via 0.0.0.x trick) ----
function socks4Connect(proxy, host, port, cb) {
  let done = false;
  const socket = net.connect(proxy.port, proxy.host);
  const onErr = (e) => finish(e);
  const onTimeout = () => { socket.destroy(); finish(new Error('SOCKS proxy timeout')); };
  const finish = (err, sock) => {
    if (done) return;
    done = true;
    socket.removeListener('error', onErr);
    socket.removeListener('timeout', onTimeout);
    if (!err) socket.setTimeout(0);
    cb(err, sock);
  };
  socket.setTimeout(15000);
  socket.on('timeout', onTimeout);
  socket.on('error', onErr);
  socket.on('connect', () => {
    const uid = Buffer.from([0x00]);
    const h = Buffer.from(host + '\0', 'utf8');
    const head = Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, 0x00, 0x00, 0x00, 0x01]);
    socket.write(Buffer.concat([head, uid, h]));
  });
  socket.once('data', (data) => {
    if (data[1] !== 0x5a) return (socket.destroy(), finish(new Error('SOCKS4 connect failed')));
    finish(null, socket);
  });
}

function tunnel(proxy, host, port, cb) {
  if (proxy.type === 4) return socks4Connect(proxy, host, port, cb);
  return socks5Connect(proxy, host, port, cb);
}

// ---- http.Agent that tunnels through SOCKS ----
class SocksHttpAgent extends http.Agent {
  constructor(proxy, opts) { super(Object.assign({ keepAlive: false }, opts)); this.proxy = proxy; }
  createConnection(options, cb) {
    tunnel(this.proxy, options.host, Number(options.port) || 80, cb);
  }
}

// ---- https.Agent: SOCKS tunnel, then TLS on top (honouring per-request TLS options) ----
class SocksHttpsAgent extends https.Agent {
  constructor(proxy, opts) { super(Object.assign({ keepAlive: false }, opts)); this.proxy = proxy; }
  createConnection(options, cb) {
    tunnel(this.proxy, options.host, Number(options.port) || 443, (err, sock) => {
      if (err) return cb(err);
      const tlsOpts = {
        socket: sock,
        servername: options.servername || options.host,
        rejectUnauthorized: options.rejectUnauthorized !== undefined ? options.rejectUnauthorized : false
      };
      // Carry the modern/legacy TLS knobs set by the caller (proxy.js upstream()).
      ['ciphers', 'minVersion', 'maxVersion', 'secureOptions'].forEach((k) => {
        if (options[k] !== undefined) tlsOpts[k] = options[k];
      });
      const tlsSock = tls.connect(tlsOpts, () => cb(null, tlsSock));
      tlsSock.once('error', cb);
    });
  }
}

// Tolerate common mistyped proxy URLs before parsing:
//   "socks5:https://h:p"  (double scheme)  -> "socks5://h:p"
//   "socks5:h:p"          (missing //)     -> "socks5://h:p"
//   "212.77.75.25:1088"   (bare host:port) -> "socks5://212.77.75.25:1088"
function normalizeProxyUrl(raw) {
  raw = (raw || '').trim();
  if (!raw) return '';
  // collapse an accidental inner scheme: "socks5:https://" / "socks5://http://" -> "socks5://"
  raw = raw.replace(/^(socks[45]?h?|https?):\/*\s*(?:https?|socks[45]?h?):\/\//i, '$1://');
  // "scheme:host:port" with no slashes -> "scheme://host:port"
  raw = raw.replace(/^(socks[45]?h?|https?):(?!\/)/i, '$1://');
  // no scheme at all (bare host:port) -> assume socks5
  if (!/^[a-z][a-z0-9+.\-]*:\/\//i.test(raw)) raw = 'socks5://' + raw;
  return raw;
}

// ---- HTTP proxy via CONNECT tunnel (dependency-free) ----
function httpConnect(proxy, host, port, cb) {
  let done = false;
  let socket;
  const finish = (err, sock) => {
    if (done) return;
    done = true;
    if (socket) {
      socket.removeListener('error', onErr);
      socket.removeListener('timeout', onTimeout);
      if (!err) socket.setTimeout(0);
    }
    cb(err, sock);
  };
  const lib = proxy.tls ? tls : net;
  const opts = proxy.tls
    ? { host: proxy.host, port: proxy.port, servername: proxy.host, rejectUnauthorized: false }
    : { host: proxy.host, port: proxy.port };
  socket = lib.connect(opts, () => {
    let head = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
    if (proxy.user) {
      const cred = Buffer.from(proxy.user + ':' + (proxy.pass || ''), 'utf8').toString('base64');
      head += `Proxy-Authorization: Basic ${cred}\r\n`;
    }
    head += 'Proxy-Connection: keep-alive\r\n\r\n';
    socket.write(head);
  });
  const onErr = (e) => finish(e);
  const onTimeout = () => { socket.destroy(); finish(new Error('HTTP proxy timeout')); };
  socket.setTimeout(15000);
  socket.on('timeout', onTimeout);
  socket.on('error', onErr);

  let buf = '';
  const onData = (d) => {
    buf += d.toString('latin1');
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) { if (buf.length > 8192) { socket.destroy(); finish(new Error('Bad CONNECT reply')); } return; }
    socket.removeListener('data', onData);
    const status = parseInt((buf.split(' ')[1] || '0'), 10);
    if (status !== 200) { socket.destroy(); return finish(new Error('HTTP proxy CONNECT failed (' + status + ')')); }
    finish(null, socket);
  };
  socket.on('data', onData);
}

class HttpProxyHttpAgent extends http.Agent {
  constructor(proxy, opts) { super(Object.assign({ keepAlive: false }, opts)); this.proxy = proxy; }
  createConnection(options, cb) { httpConnect(this.proxy, options.host, Number(options.port) || 80, cb); }
}

class HttpProxyHttpsAgent extends https.Agent {
  constructor(proxy, opts) { super(Object.assign({ keepAlive: false }, opts)); this.proxy = proxy; }
  createConnection(options, cb) {
    httpConnect(this.proxy, options.host, Number(options.port) || 443, (err, sock) => {
      if (err) return cb(err);
      const tlsOpts = {
        socket: sock,
        servername: options.servername || options.host,
        rejectUnauthorized: options.rejectUnauthorized !== undefined ? options.rejectUnauthorized : false
      };
      ['ciphers', 'minVersion', 'maxVersion', 'secureOptions'].forEach((k) => {
        if (options[k] !== undefined) tlsOpts[k] = options[k];
      });
      const t = tls.connect(tlsOpts, () => cb(null, t));
      t.once('error', cb);
    });
  }
}

// Parse socks5://user:pass@host:port into a proxy descriptor.
function parseProxy(proxyUrl) {
  proxyUrl = normalizeProxyUrl(proxyUrl);
  if (!proxyUrl) return null;
  let u;
  try { u = new URL(proxyUrl); } catch (e) { return null; }
  if (!u.hostname) return null;
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (scheme.indexOf('socks') !== 0) return null;      // only socks here; http proxies handled elsewhere
  return {
    type: scheme === 'socks4' || scheme === 'socks4a' ? 4 : 5,
    host: u.hostname,
    port: Number(u.port) || 1080,
    user: u.username ? decodeURIComponent(u.username) : '',
    pass: u.password ? decodeURIComponent(u.password) : ''
  };
}

// Build reusable {http, https} agents for a socks proxy url, or null if not socks.
function makeProxyAgents(proxyUrl) {
  const proxy = parseProxy(proxyUrl);
  if (!proxy) return null;
  return { proxy: proxy, http: new SocksHttpAgent(proxy), https: new SocksHttpsAgent(proxy) };
}

// Build {http, https} agents for ANY supported proxy URL: socks5/socks4 or http/https.
// Returns null if the URL can't be parsed.
function makeAnyProxyAgents(proxyUrl) {
  const raw = normalizeProxyUrl(proxyUrl);
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (scheme.indexOf('socks') === 0) return makeProxyAgents(raw);
  if (scheme !== 'http' && scheme !== 'https') return null;
  const proxy = {
    tls: scheme === 'https',
    host: u.hostname,
    port: Number(u.port) || (scheme === 'https' ? 443 : 80),
    user: u.username ? decodeURIComponent(u.username) : '',
    pass: u.password ? decodeURIComponent(u.password) : ''
  };
  if (!proxy.host) return null;
  return { proxy: proxy, http: new HttpProxyHttpAgent(proxy), https: new HttpProxyHttpsAgent(proxy) };
}

module.exports = { makeProxyAgents, makeAnyProxyAgents, parseProxy, normalizeProxyUrl };
