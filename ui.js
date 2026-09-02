'use strict';
/**
 * The dashboard, served as one self-contained page.
 *
 * It lives in a .js file rather than a .html one so the Dockerfile's `COPY *.js` keeps working and
 * there is no static directory to get out of step with the image.
 *
 * Layout is a master/detail: a scrolling sidebar lists every line (with a health summary and a
 * search/filter pinned at its top), and the pane on the right shows the selected line in full. This
 * is what keeps the page usable once there are dozens of lines — the old one-tall-card-per-line
 * stack turned into an endless scroll with no overview.
 *
 * Every value that came from configuration or from a portal is put on the page with textContent,
 * never innerHTML. Channel and line names are attacker-influenced in the general case, and an
 * innerHTML assignment here would execute inside an authenticated admin session.
 */

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1e222b; --line: #2a2f3a;
    --fg: #e6e9ef; --dim: #98a0b0; --accent: #4c8dff; --ok: #35c07f; --bad: #ef5a5a;
    --warn: #e6a13c;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  a { color: var(--accent); }
  header {
    display: flex; align-items: center; gap: 12px; flex: none;
    padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  header .sp { flex: 1; }

  button {
    font: inherit; cursor: pointer; border-radius: 8px; border: 1px solid var(--line);
    background: var(--panel2); color: var(--fg); padding: 7px 13px;
  }
  button:hover { border-color: #3a4150; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--bad); }
  button.sm { padding: 4px 9px; font-size: 13px; }
  button:disabled { opacity: .5; cursor: default; }

  input, select {
    font: inherit; width: 100%; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  label { display: block; margin-bottom: 12px; }
  label span.lbl { display: block; font-size: 12px; color: var(--dim); margin-bottom: 4px; }
  label span.hint { display: block; font-size: 12px; color: var(--dim); margin-top: 4px; }

  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); flex: none; }
  .dot.on { background: var(--ok); }
  .dot.off { background: var(--bad); }
  .dot.recon { background: var(--warn); animation: pulse 1.1s ease-in-out infinite; }
  .dot.dis { background: var(--dim); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

  /* ---- master / detail shell ---- */
  .shell { display: flex; flex-direction: column; height: 100vh; }
  .layout { flex: 1; display: flex; min-height: 0; }

  .sidebar {
    width: 320px; flex: none; display: flex; flex-direction: column;
    border-right: 1px solid var(--line); background: var(--panel); overflow: hidden;
  }
  .side-top { padding: 12px; border-bottom: 1px solid var(--line); flex: none; }
  .summary { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .chip {
    font-size: 12px; padding: 3px 9px; border-radius: 20px; background: var(--panel2);
    border: 1px solid var(--line); color: var(--dim); white-space: nowrap;
  }
  .chip b { color: var(--fg); font-weight: 600; }
  .chip.ok b { color: var(--ok); }
  .chip.bad b { color: var(--bad); }
  .chip.live b { color: var(--accent); }
  .filters { display: flex; gap: 6px; margin-top: 8px; }
  .filters button { flex: 1; padding: 5px 0; font-size: 12px; }
  .filters button.active { background: var(--accent); border-color: var(--accent); color: #fff; }

  .side-list { flex: 1; overflow-y: auto; }
  .lineitem {
    display: flex; align-items: center; gap: 10px; padding: 11px 14px; cursor: pointer;
    border-bottom: 1px solid var(--line); border-left: 3px solid transparent;
  }
  .lineitem:hover { background: var(--panel2); }
  .lineitem.sel { background: var(--panel2); border-left-color: var(--accent); }
  .lineitem .body { min-width: 0; flex: 1; }
  .lineitem .nm { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lineitem .meta {
    font-size: 12px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .lineitem .live { font-size: 12px; color: var(--accent); flex: none; font-variant-numeric: tabular-nums; }
  .side-empty { padding: 30px 16px; color: var(--dim); text-align: center; font-size: 13px; }

  /* ---- detail pane ---- */
  .detail { flex: 1; overflow-y: auto; min-width: 0; }
  .detail .pad { padding: 22px;}
  .detail .placeholder { color: var(--dim); text-align: center; padding: 60px 20px; }
  .dhead { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .dhead h2 { font-size: 20px; margin: 0; font-weight: 600; }
  .dhead .badge { font-size: 12px; color: var(--dim); }
  .dsub { color: var(--dim); font-size: 13px; margin-bottom: 18px; font-family: ui-monospace, Menlo, Consolas, monospace; }

  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 16px; margin-bottom: 14px;
  }
  .card h2 { font-size: 16px; margin: 0; font-weight: 600; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .kv .k { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); }
  .kv .v { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; word-break: break-all; }

  .urls { display: flex; flex-direction: column; gap: 6px; }
  .urlrow { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .urlrow .lab { font-size: 12px; color: var(--dim); min-width: 74px; flex: none; }
  .urlrow code {
    /* min-width:0 lets this shrink below the URL's length so a long playlist link scrolls inside
       the box instead of forcing the row wider than the card and pushing Copy past its edge. */
    flex: 1; min-width: 0; font-size: 12px; background: var(--bg); padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--line); overflow-x: auto; white-space: nowrap;
  }
  .urlrow button { flex: none; }
  .actions { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }

  .streams { font-size: 13px; color: var(--dim); }
  .streams .hd { margin-bottom: 6px; }
  .streams .row { font-family: ui-monospace, Menlo, Consolas, monospace; }

  .sec-title { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: var(--dim); margin: 0 0 10px; }

  dialog {
    border: 1px solid var(--line); border-radius: 14px; background: var(--panel); color: var(--fg);
    padding: 0; width: min(560px, 94vw);
  }
  dialog::backdrop { background: rgba(0,0,0,.6); }
  dialog .body { padding: 20px; max-height: 78vh; overflow-y: auto; }
  dialog h3 { margin: 0 0 16px; font-size: 16px; }
  dialog .foot {
    display: flex; gap: 8px; justify-content: flex-end; padding: 14px 20px;
    border-top: 1px solid var(--line); background: var(--panel2);
    border-radius: 0 0 14px 14px;
  }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }

  .msg { padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; font-size: 14px; display: none; }
  .msg.show { display: block; }
  .msg.err { background: rgba(239,90,90,.13); color: #ff9d9d; border: 1px solid rgba(239,90,90,.3); }
  .msg.ok  { background: rgba(53,192,127,.12); color: #7ee2b0; border: 1px solid rgba(53,192,127,.3); }

  .login { max-width: 340px; margin: 14vh auto; padding: 0 16px; }
  .login .card { padding: 20px; }
  .toast {
    position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
    background: var(--panel2); border: 1px solid var(--line); padding: 9px 16px;
    border-radius: 8px; font-size: 14px; opacity: 0; transition: opacity .18s; pointer-events: none;
    z-index: 50;
  }
  .toast.show { opacity: 1; }

  @media (max-width: 720px) {
    .layout { flex-direction: column; }
    .sidebar { width: 100%; height: auto; max-height: 46vh; border-right: none; border-bottom: 1px solid var(--line); }
    .two { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div id="app"></div>
<div class="toast" id="toast"></div>

<dialog id="dlg">
  <form method="dialog" id="dlgForm">
    <div class="body">
      <h3 id="dlgTitle">Add a line</h3>
      <div class="msg err" id="dlgMsg"></div>

      <label><span class="lbl">Name</span>
        <input id="f_name" placeholder="Living room line" maxlength="60"></label>

      <label><span class="lbl">Portal URL</span>
        <input id="f_portal" placeholder="http://portal.example.net/c/" required>
        <span class="hint">The portal address from your provider.</span></label>

      <div class="two">
        <label><span class="lbl">MAC address</span>
          <input id="f_mac" placeholder="00:1A:79:00:00:00" required></label>
        <label><span class="lbl">Max connections</span>
          <input id="f_max" type="number" min="1" max="20" value="2">
          <span class="hint">What your line allows.</span></label>
      </div>

      <div class="two">
        <label><span class="lbl">Dedicated port</span>
          <input id="f_port" type="number" placeholder="none">
          <span class="hint" id="portHint"></span></label>
        <label><span class="lbl">Password for players</span>
          <input id="f_pass" required minlength="4"></label>
      </div>

      <div class="two">
        <label><span class="lbl">Timezone</span>
          <input id="f_tz" value="Europe/London"></label>
        <label><span class="lbl">Enabled</span>
          <select id="f_enabled">
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select></label>
      </div>

      <div class="two">
        <label><span class="lbl">Delivery</span>
          <select id="f_delivery">
            <option value="proxy">Proxy — relay streams the bytes</option>
            <option value="redirect">Redirect — device plays the edge URL</option>
          </select>
          <span class="hint">Redirect only if the edge is reachable from your devices.</span></label>
        <label><span class="lbl">Unmetered edge</span>
          <select id="f_unmetered">
            <option value="0">No — respect max connections</option>
            <option value="1">Yes — no connection cap</option>
          </select>
          <span class="hint">Only if the source caps at the portal, not the stream URL.</span></label>
      </div>

      <div class="two">
        <label><span class="lbl">Smooth live (ffmpeg)</span>
          <select id="f_remuxlive">
            <option value="0">No — pass live through untouched</option>
            <option value="1">Yes — remux live to fix mobile stutter</option>
          </select>
          <span class="hint">Fixes mobile cut-outs at edge swaps. Costs CPU per active channel.</span></label>
        <label></label>
      </div>

      <label><span class="lbl">EPG URL (optional)</span>
        <input id="f_epg" placeholder="Leave empty to build one from the portal"></label>

      <label><span class="lbl">User agent (optional)</span>
        <input id="f_ua" placeholder="Only if your provider needs a specific one"></label>
    </div>
    <div class="foot">
      <button type="button" id="btnTest">Test portal</button>
      <div style="flex:1"></div>
      <button type="button" id="btnCancel">Cancel</button>
      <button type="button" class="primary" id="btnSave">Save</button>
    </div>
  </form>
</dialog>

<dialog id="pwDlg">
  <form method="dialog">
    <div class="body">
      <h3>Change dashboard password</h3>
      <div class="msg err" id="pwMsg"></div>
      <label><span class="lbl">Current password</span><input type="password" id="pw_cur"></label>
      <label><span class="lbl">New password</span><input type="password" id="pw_new">
        <span class="hint">At least 8 characters.</span></label>
    </div>
    <div class="foot">
      <button type="button" id="pwCancel">Cancel</button>
      <button type="button" class="primary" id="pwSave">Change</button>
    </div>
  </form>
</dialog>

<script>
(function () {
  'use strict';

  var app = document.getElementById('app');
  var state = {
    lines: [], portRange: [4701, 4720], editing: null, refresh: null,
    selected: null, filter: 'all', query: '',
  };

  // ---- tiny DOM helpers ------------------------------------------------------------------
  // el() never takes markup. Text goes in as text, always — a line named after a channel could
  // contain anything, and this page runs inside an authenticated admin session.
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function kv(k, v) {
    var w = el('div', 'kv');
    w.appendChild(el('div', 'k', k));
    w.appendChild(el('div', 'v', v));
    return w;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1900);
  }

  function api(path, opts) {
    return fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
        return body;
      });
    });
  }

  // The dashboard is normally reached over plain http on a LAN address, where the clipboard API
  // is unavailable because the origin isn't "secure". The textarea fallback is the path that
  // actually runs most of the time, not an edge case.
  function copy(textToCopy) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = textToCopy;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? 'Copied' : 'Press Ctrl+C to copy');
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(textToCopy).then(function () { toast('Copied'); }, fallback);
    } else {
      fallback();
    }
  }

  // ---- login -------------------------------------------------------------------------------

  function renderLogin(errMsg) {
    clear(app);
    var wrap = el('div', 'login');
    var card = el('div', 'card');
    card.appendChild(el('h2', null, 'Relay'));
    var msg = el('div', 'msg err');
    if (errMsg) { msg.textContent = errMsg; msg.classList.add('show'); }
    card.appendChild(msg);

    var lab = el('label');
    lab.appendChild(el('span', 'lbl', 'Dashboard password'));
    var inp = document.createElement('input');
    inp.type = 'password';
    inp.autofocus = true;
    lab.appendChild(inp);
    card.appendChild(lab);

    var btn = el('button', 'primary', 'Sign in');
    btn.style.width = '100%';
    card.appendChild(btn);

    function go() {
      btn.disabled = true;
      api('/api/login', { method: 'POST', body: JSON.stringify({ password: inp.value }) })
        .then(boot)
        .catch(function (e) { renderLogin(e.message); });
    }
    btn.addEventListener('click', go);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

    wrap.appendChild(card);
    app.appendChild(wrap);
    setTimeout(function () { inp.focus(); }, 0);
  }

  // ---- shell (built once) ------------------------------------------------------------------

  function renderApp() {
    clear(app);

    var shell = el('div', 'shell');

    var head = el('header');
    head.appendChild(el('h1', null, 'Relay'));
    head.appendChild(el('div', 'sp'));

    var addBtn = el('button', 'primary', 'Add line');
    addBtn.addEventListener('click', function () { openDialog(null); });
    head.appendChild(addBtn);

    var pwBtn = el('button', null, 'Password');
    pwBtn.addEventListener('click', openPassword);
    head.appendChild(pwBtn);

    var out = el('button', null, 'Sign out');
    out.addEventListener('click', function () {
      api('/api/logout', { method: 'POST' }).then(function () {
        if (state.refresh) clearInterval(state.refresh);
        renderLogin();
      });
    });
    head.appendChild(out);
    shell.appendChild(head);

    var layout = el('div', 'layout');

    // Sidebar: summary + search + filters (built once), then the scrolling list.
    var side = el('div', 'sidebar');
    var top = el('div', 'side-top');
    var summary = el('div', 'summary'); summary.id = 'summary';
    top.appendChild(summary);

    var search = document.createElement('input');
    search.id = 'searchInput';
    search.placeholder = 'Search lines…';
    search.value = state.query;
    search.addEventListener('input', function () { state.query = search.value; renderList(); });
    top.appendChild(search);

    var filters = el('div', 'filters');
    ['all', 'connected', 'errored'].forEach(function (f) {
      var b = el('button', 'filt' + (state.filter === f ? ' active' : ''),
        f === 'all' ? 'All' : (f === 'connected' ? 'Up' : 'Errored'));
      b.dataset.f = f;
      b.addEventListener('click', function () {
        state.filter = f;
        Array.prototype.forEach.call(filters.children, function (c) {
          c.classList.toggle('active', c.dataset.f === f);
        });
        renderList();
      });
      filters.appendChild(b);
    });
    top.appendChild(filters);
    side.appendChild(top);

    var list = el('div', 'side-list'); list.id = 'linelist';
    side.appendChild(list);
    layout.appendChild(side);

    var detail = el('div', 'detail'); detail.id = 'detail';
    layout.appendChild(detail);

    shell.appendChild(layout);
    app.appendChild(shell);

    renderData();
  }

  // ---- data-driven render (on every refresh) ----------------------------------------------

  function statusOf(l) {
    if (!l.enabled) return { cls: 'dis', label: 'disabled' };
    if (l.status && l.status.reconnecting) return { cls: 'recon', label: 'reconnecting' };
    if (l.status && l.status.connected) return { cls: 'on', label: 'connected' };
    return { cls: 'off', label: l.status && l.status.error ? 'error' : 'not connected' };
  }

  function liveCount(l) {
    var streams = (l.status && l.status.streams) || [];
    var live = 0, files = 0;
    streams.forEach(function (s) { if (s.kind === 'live') live += (s.viewers || 1); else files++; });
    return { live: live, files: files };
  }

  function matchesFilter(l) {
    if (state.query) {
      var q = state.query.toLowerCase();
      var hay = ((l.name || '') + ' ' + (l.portal || '') + ' ' + (l.mac || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    if (state.filter === 'connected') return l.enabled && l.status && l.status.connected;
    if (state.filter === 'errored') {
      return l.enabled && l.status && !l.status.connected;   // includes reconnecting + hard error
    }
    return true;
  }

  function renderData() {
    // Keep a valid selection across refreshes; default to the first line.
    if (state.lines.length) {
      var stillThere = state.lines.some(function (l) { return l.id === state.selected; });
      if (!stillThere) state.selected = state.lines[0].id;
    } else {
      state.selected = null;
    }
    renderSummary();
    renderList();
    renderDetail();
  }

  function renderSummary() {
    var box = document.getElementById('summary');
    if (!box) return;
    clear(box);
    var total = state.lines.length;
    var up = 0, bad = 0, live = 0;
    state.lines.forEach(function (l) {
      if (l.enabled && l.status && l.status.connected) up++;
      if (l.enabled && l.status && !l.status.connected) bad++;
      live += liveCount(l).live;
    });
    box.appendChild(chip(null, total, total === 1 ? 'line' : 'lines'));
    box.appendChild(chip('ok', up, 'up'));
    if (bad) box.appendChild(chip('bad', bad, 'down'));
    box.appendChild(chip('live', live, 'live'));
  }

  function chip(cls, n, label) {
    var c = el('div', 'chip' + (cls ? ' ' + cls : ''));
    c.appendChild(el('b', null, n));
    c.appendChild(document.createTextNode(' ' + label));
    return c;
  }

  function renderList() {
    var list = document.getElementById('linelist');
    if (!list) return;
    clear(list);

    if (!state.lines.length) {
      var e = el('div', 'side-empty');
      e.appendChild(el('div', null, 'No lines yet.'));
      e.appendChild(el('div', null, 'Add one to get started.'));
      list.appendChild(e);
      return;
    }

    var shown = state.lines.filter(matchesFilter);
    if (!shown.length) {
      list.appendChild(el('div', 'side-empty', 'No lines match.'));
      return;
    }

    shown.forEach(function (l) {
      var st = statusOf(l);
      var item = el('div', 'lineitem' + (l.id === state.selected ? ' sel' : ''));
      item.appendChild(el('div', 'dot ' + st.cls));

      var body = el('div', 'body');
      body.appendChild(el('div', 'nm', l.name || '(unnamed)'));
      var lc = liveCount(l);
      var conns = (l.status ? l.status.active : 0) + '/' + l.maxConnections;
      body.appendChild(el('div', 'meta', hostOf(l.portal) + ' · ' + conns));
      item.appendChild(body);

      if (lc.live) item.appendChild(el('div', 'live', '● ' + lc.live));
      else if (lc.files) item.appendChild(el('div', 'live', '▶ ' + lc.files));

      item.addEventListener('click', function () {
        state.selected = l.id;
        renderList();
        renderDetail();
      });
      list.appendChild(item);
    });
  }

  function renderDetail() {
    var pane = document.getElementById('detail');
    if (!pane) return;
    clear(pane);

    var l = state.lines.filter(function (x) { return x.id === state.selected; })[0];
    if (!l) {
      pane.appendChild(el('div', 'placeholder', state.lines.length ? 'Select a line.' : 'Add a line to get started.'));
      return;
    }

    var pad = el('div', 'pad');
    var st = statusOf(l);

    var head = el('div', 'dhead');
    head.appendChild(el('div', 'dot ' + st.cls));
    head.appendChild(el('h2', null, l.name || '(unnamed)'));
    var spacer = el('div');
    spacer.style.flex = '1';
    head.appendChild(spacer);
    head.appendChild(el('div', 'badge', st.label));
    pad.appendChild(head);

    pad.appendChild(el('div', 'dsub', hostOf(l.portal) + ' · ' + (l.mac || '')));

    if (l.status && l.status.error && !l.status.connected) {
      pad.appendChild(el('div', 'msg err show', l.status.error));
    }

    // Overview card
    var ov = el('div', 'card');
    var grid = el('div', 'grid');
    grid.appendChild(kv('Portal', hostOf(l.portal)));
    grid.appendChild(kv('MAC', l.mac));
    grid.appendChild(kv('Port', l.port ? String(l.port) : 'shared'));
    grid.appendChild(kv('Connections', (l.status ? l.status.active : 0) + ' / ' + l.maxConnections));
    grid.appendChild(kv('Delivery', l.delivery || 'proxy'));
    ov.appendChild(grid);

    var c = l.status && l.status.catalog;
    if (c) {
      var cg = el('div', 'grid');
      cg.style.marginTop = '12px';
      cg.appendChild(kv('Channels', c.channels || 0));
      cg.appendChild(kv('Films', c.films || 0));
      cg.appendChild(kv('Series', c.series || 0));
      cg.appendChild(kv('Catalogue', c.warming
        ? ('building — ' + c.step + ' (' + (c.items || 0) + ')')
        : (c.error ? c.error : (c.done ? 'ready' : (c.step || 'idle')))));
      ov.appendChild(cg);
    }
    pad.appendChild(ov);

    // Playing now
    if (l.status && l.status.streams && l.status.streams.length) {
      var sc = el('div', 'card');
      var st2 = el('div', 'streams');
      st2.appendChild(el('div', 'hd', 'Playing now'));
      l.status.streams.forEach(function (s) {
        var line = (s.kind === 'live' ? '● ' : '▶ ') + (s.label || s.key);
        // Live refs are genuine viewers (fan-out across devices). A file lease is keyed per device,
        // so its refs are overlapping range requests from ONE viewer seeking/buffering — call those
        // requests, not viewers, or a single person skipping ahead reads as a crowd.
        if (s.viewers > 1) line += '  (' + s.viewers + (s.kind === 'live' ? ' viewers)' : ' requests)');
        if (s.since) line += '  ' + ago(s.since);
        st2.appendChild(el('div', 'row', line));
      });
      sc.appendChild(st2);
      pad.appendChild(sc);
    }

    // URLs for a player
    var host = location.hostname;
    var base = l.port ? ('http://' + host + ':' + l.port) : (location.protocol + '//' + location.host);
    var user = l.port ? 'relay' : l.mac;
    var uc = el('div', 'card');
    uc.appendChild(el('div', 'sec-title', 'Player setup'));
    var urls = el('div', 'urls');
    urls.appendChild(urlRow('Server', base));
    urls.appendChild(urlRow('Username', user));
    urls.appendChild(urlRow('Password', l.password));
    urls.appendChild(urlRow('Playlist', base + '/get.php?username=' + encodeURIComponent(user) +
      '&password=' + encodeURIComponent(l.password)));
    uc.appendChild(urls);
    pad.appendChild(uc);

    // Actions
    var acts = el('div', 'actions');
    var edit = el('button', 'sm', 'Edit');
    edit.addEventListener('click', function () { openDialog(l); });
    acts.appendChild(edit);

    var rc = el('button', 'sm', 'Reconnect');
    rc.addEventListener('click', function () {
      rc.disabled = true;
      rc.textContent = 'Reconnecting…';
      api('/api/lines/' + l.id + '/reconnect', { method: 'POST' })
        .then(function (r) { toast(r.connected ? 'Connected' : (r.error || 'Could not connect')); })
        .catch(function (e) { toast(e.message); })
        .then(refresh);
    });
    acts.appendChild(rc);

    var rb = el('button', 'sm', 'Rebuild catalogue');
    rb.addEventListener('click', function () {
      rb.disabled = true;
      api('/api/lines/' + l.id + '/rebuild', { method: 'POST' })
        .then(function () { toast('Rebuilding in the background'); })
        .catch(function (e) { toast(e.message); })
        .then(function () { rb.disabled = false; refresh(); });
    });
    acts.appendChild(rb);

    acts.appendChild(el('div', 'sp'));
    acts.lastChild.style.flex = '1';

    var del = el('button', 'sm danger', 'Delete');
    del.addEventListener('click', function () {
      if (!window.confirm('Delete "' + l.name + '"? Players using it will stop working.')) return;
      api('/api/lines/' + l.id, { method: 'DELETE' })
        .then(function () { toast('Deleted'); refresh(); })
        .catch(function (e) { toast(e.message); });
    });
    acts.appendChild(del);
    pad.appendChild(acts);

    pane.appendChild(pad);
  }

  function urlRow(label, value) {
    var row = el('div', 'urlrow');
    row.appendChild(el('div', 'lab', label));
    row.appendChild(el('code', null, value));
    var b = el('button', 'sm', 'Copy');
    b.addEventListener('click', function () { copy(value); });
    row.appendChild(b);
    return row;
  }

  function hostOf(u) {
    try { return new URL(u).host; } catch (e) { return u || ''; }
  }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h' + (Math.floor(s / 60) % 60) + 'm';
  }

  // ---- add / edit --------------------------------------------------------------------------

  var dlg = document.getElementById('dlg');
  var F = {
    name: 'f_name', portal: 'f_portal', mac: 'f_mac', max: 'f_max', port: 'f_port',
    pass: 'f_pass', tz: 'f_tz', epg: 'f_epg', ua: 'f_ua', enabled: 'f_enabled',
    delivery: 'f_delivery', unmetered: 'f_unmetered', remuxlive: 'f_remuxlive',
  };
  function fv(k) { return document.getElementById(F[k]).value; }
  function setf(k, v) { document.getElementById(F[k]).value = v == null ? '' : String(v); }

  function dlgError(m) {
    var box = document.getElementById('dlgMsg');
    box.textContent = m || '';
    box.className = 'msg err' + (m ? ' show' : '');
  }
  function dlgOk(m) {
    var box = document.getElementById('dlgMsg');
    box.textContent = m || '';
    box.className = 'msg ok' + (m ? ' show' : '');
  }

  function openDialog(line) {
    state.editing = line;
    document.getElementById('dlgTitle').textContent = line ? 'Edit line' : 'Add a line';
    document.getElementById('portHint').textContent =
      'Optional. ' + state.portRange[0] + '-' + state.portRange[1] + ', or blank to share the main port.';
    dlgError('');
    setf('name', line ? line.name : '');
    setf('portal', line ? line.portal : '');
    setf('mac', line ? line.mac : '');
    setf('max', line ? line.maxConnections : 2);
    setf('port', line && line.port ? line.port : '');
    setf('pass', line ? line.password : randomPassword());
    setf('tz', line ? line.timezone : 'Europe/London');
    setf('epg', line ? line.epgUrl : '');
    setf('ua', line ? line.userAgent : '');
    setf('delivery', line ? (line.delivery || 'proxy') : 'proxy');
    setf('unmetered', line ? (line.unmetered ? '1' : '0') : '0');
    setf('remuxlive', line ? (line.remuxLive ? '1' : '0') : '0');
    setf('enabled', line ? (line.enabled ? '1' : '0') : '1');
    dlg.showModal();
  }

  function randomPassword() {
    var a = 'abcdefghijkmnpqrstuvwxyz23456789';
    var s = '';
    var buf = new Uint8Array(10);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < buf.length; i++) s += a[buf[i] % a.length];
    return s;
  }

  function collect() {
    return {
      name: fv('name'),
      portal: fv('portal').trim(),
      mac: fv('mac').trim(),
      maxConnections: fv('max'),
      port: fv('port').trim(),
      password: fv('pass'),
      timezone: fv('tz').trim(),
      epgUrl: fv('epg').trim(),
      userAgent: fv('ua').trim(),
      delivery: fv('delivery'),
      unmetered: fv('unmetered') === '1',
      remuxLive: fv('remuxlive') === '1',
      enabled: fv('enabled') === '1',
    };
  }

  document.getElementById('btnCancel').addEventListener('click', function () { dlg.close(); });

  document.getElementById('btnSave').addEventListener('click', function () {
    var btn = this;
    var body = collect();
    var path = state.editing ? ('/api/lines/' + state.editing.id) : '/api/lines';
    var method = state.editing ? 'PUT' : 'POST';
    btn.disabled = true;
    api(path, { method: method, body: JSON.stringify(body) })
      .then(function (r) {
        // Select a newly added line so its player URLs are right there.
        if (!state.editing && r && r.line) state.selected = r.line.id;
        dlg.close(); toast('Saved'); refresh();
      })
      .catch(function (e) { dlgError(e.message); })
      .then(function () { btn.disabled = false; });
  });

  document.getElementById('btnTest').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Testing…';
    dlgError('');
    api('/api/test', { method: 'POST', body: JSON.stringify(collect()) })
      .then(function (r) { if (r.ok) dlgOk(r.message); else dlgError(r.message); })
      .catch(function (e) { dlgError(e.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Test portal'; });
  });

  // ---- password ----------------------------------------------------------------------------

  var pwDlg = document.getElementById('pwDlg');
  function openPassword() {
    document.getElementById('pw_cur').value = '';
    document.getElementById('pw_new').value = '';
    var m = document.getElementById('pwMsg');
    m.textContent = '';
    m.className = 'msg err';
    pwDlg.showModal();
  }
  document.getElementById('pwCancel').addEventListener('click', function () { pwDlg.close(); });
  document.getElementById('pwSave').addEventListener('click', function () {
    var m = document.getElementById('pwMsg');
    api('/api/password', {
      method: 'POST',
      body: JSON.stringify({
        current: document.getElementById('pw_cur').value,
        next: document.getElementById('pw_new').value,
      }),
    }).then(function () { pwDlg.close(); toast('Password changed'); })
      .catch(function (e) { m.textContent = e.message; m.className = 'msg err show'; });
  });

  // ---- boot --------------------------------------------------------------------------------

  function refresh() {
    return api('/api/lines').then(function (r) {
      state.lines = r.lines || [];
      if (r.portRange) state.portRange = r.portRange;
      // Only the data-driven parts re-render; the shell, search box and filters stay put so typing
      // a search or scrolling the list isn't interrupted every 5 seconds.
      if (document.getElementById('detail')) renderData();
      else renderApp();
    }).catch(function (e) {
      // A dropped session should return to the login screen rather than silently freezing.
      if (/signed in/i.test(e.message)) {
        if (state.refresh) clearInterval(state.refresh);
        renderLogin('Session expired — sign in again.');
      }
    });
  }

  function boot() {
    renderApp();
    refresh();
    if (state.refresh) clearInterval(state.refresh);
    state.refresh = setInterval(refresh, 5000);
  }

  api('/api/session').then(function (r) {
    if (r.portRange) state.portRange = r.portRange;
    if (r.authed) boot(); else renderLogin();
  }).catch(function () { renderLogin('Could not reach the relay.'); });
})();
</script>
</body>
</html>`;

function serve(req, res) {
  const body = Buffer.from(PAGE, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    // The page is the control surface for credentials; a stale cached copy after an upgrade would
    // talk to an API that has moved on.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // No third-party anything: everything the page needs is inline.
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

module.exports = { serve, PAGE };
