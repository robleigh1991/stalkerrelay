# Stalker Relay

One portal, many devices — with a dashboard to manage it.

## The problem it solves

A Stalker/Ministra portal allows **one live session per MAC**. Every handshake mints a fresh token
and silently invalidates the previous one. So two clients on the same line don't share it — they
evict each other, in a loop, producing the `MAG_TOKEN_INVALID` and 401 churn you get the moment you
run a desktop app and a proxy against the same subscription. Add a phone and it gets worse.

The relay is the **only thing that ever talks to the portal**. It handshakes once, keeps the session
warm, and re-authenticates when the portal expires it. Your devices authenticate to *the relay*,
over the Xtream Codes API, so they cannot evict one another.

It also enforces the line's concurrent-stream limit itself and **fans out shared channels**: two
devices watching the same channel is one connection upstream, not two.

```
   phone  ─┐
   desktop ─┼── Xtream ──▶  relay ── 1 session ──▶  portal
   TV      ─┘
```

## Deploying with Portainer

**Stacks → Add stack → Repository**

| Field | Value |
|---|---|
| Repository URL | `https://github.com/robleigh1991/stalkerrelay` |
| Reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |

Optionally set `RELAY_ADMIN_PASSWORD` under **Environment variables**. If you don't, the relay
generates one on first start and prints it to the container log:

```
[config]   No RELAY_ADMIN_PASSWORD set. Generated one for the dashboard:
[config]       kR3nP-xQ2vT8
```

Then open **http://your-host:4700**, sign in, and add your lines. Nothing else needs configuring,
and no credentials are stored in the repo or the stack file.

### Without Docker

```bash
RELAY_ADMIN_PASSWORD=something node server.js
```

Node 18+, no dependencies to install.

## Adding a line

**Add line** in the dashboard. You need the portal URL and the MAC; everything else has a sensible
default. **Test portal** does a throwaway handshake so a typo is caught here rather than by a player
failing silently three screens later.

| Field | What it does |
|---|---|
| Portal URL | The address your provider gave you |
| MAC address | The MAC for this line |
| Max connections | What the line actually allows — the relay enforces it |
| Dedicated port | Optional; see below |
| Password | What players use. Generated for you; change it if you like |
| EPG URL | Optional external XMLTV. Empty builds a guide from the portal |

The test never touches a running line's session, because testing a MAC that is already in use would
evict it — the exact failure this service exists to prevent.

## One port, or a port each

**Shared port (default).** Everything on 4700. A player picks its line by sending that line's MAC as
the username. Simple, and nothing extra to publish in Docker.

**Dedicated port.** Give a line a port in 4701–4720 and it gets its own listener. The username then
doesn't matter — the port already says which line it is. Worth doing when:

- a player struggles with two accounts on the same host and port
- you want to hand someone a plain server address without explaining MAC addresses
- you want one line reachable without the others

The whole 4701–4720 range is published by the compose file up front, because Docker cannot add a
published port to a running container — otherwise choosing a port in the dashboard would need a
stack redeploy to take effect. Changing a line's port moves its listener immediately; clearing it
closes the listener and the line stays reachable on the shared port.

## Pointing devices at it

Each line card shows exactly what to type, with copy buttons:

| Field | Shared port | Dedicated port |
|---|---|---|
| Server | `http://host:4700` | `http://host:4703` |
| Username | the line's **MAC** | anything |
| Password | the line's password | the line's password |

Works with TiviMate, OTT Navigator, VLC, STB Player and anything else that speaks Xtream. There's a
playlist URL too, for players that want a list rather than the API.

> **While testing, don't leave another client connected directly to the same MAC.** It will
> handshake against the portal and evict the relay's session — the exact problem this solves. Point
> it at the relay, or give the relay its own MAC.

## Endpoints

| Path | Purpose |
|---|---|
| `/` | Dashboard (main port only) |
| `/api/*` | Management API (main port only, requires sign-in) |
| `/player_api.php` | Xtream API — live, VOD, series, categories, `get_series_info`, short EPG |
| `/get.php` | M3U playlist |
| `/xmltv.php` | EPG as XMLTV |
| `/live/<user>/<pass>/<id>.ts` | live stream, fanned out between devices |
| `/movie/<user>/<pass>/<id>.mp4` | film, resumable by byte offset |
| `/series/<user>/<pass>/<id>.mp4` | episode, resumable by byte offset |
| `/status` | connection counts — no credentials, no sign-in needed |
| `/health` | container health check |

The management API and dashboard are **not routed at all** on a line's own port. Those are the ports
most likely to end up forwarded through a router.

## Behaviour worth knowing

**Stream ids are stable.** They're keyed on the portal command and persisted to
`/data/relay-state.json`, so favourites survive restarts and a play URL issued an hour ago still
resolves. Ids do *not* shift when categories are filtered — deriving them from a filtered listing
is how you end up playing the wrong channel. **Keep the volume.**

**"All" means all.** `get_live_streams`, `get_vod_streams` and `get_series` with no `category_id`
return everything. That's how clients ask for a full listing, and answering with an empty array
makes a populated library look empty.

**Play links are created per playback**, never cached. Portal links are short-lived and often
single-use; replaying one is how you get a 401 ten minutes later.

**A dropped source is re-opened, not surrendered.** Live re-opens with no `Range` — there are no
byte offsets in live TV — and appends. A film resumes with `Range: bytes=N-` and *requires* a 206
from exactly that offset; a server that ignores `Range` answers 200 from zero, and appending that
would splice the opening into the middle of the film, so that case stops rather than corrupting the
stream.

**The line's limit is enforced here**, returning a readable 503 rather than letting the portal
answer a bare 456 mid-playback. A finished stream lingers a few seconds before its connection is
released, so channel surfing doesn't spend a slot reopening what you just closed.

## Configuration

Lines live in the dashboard. These are the only environment variables that matter:

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_ADMIN_PASSWORD` | generated | Dashboard password. Set it to override and to recover a lost one |
| `RELAY_PORT` | `4700` | Dashboard and shared endpoint |
| `RELAY_PORT_MIN` / `MAX` | `4701` / `4720` | Ports a line may claim; must match what Docker publishes |
| `RELAY_TZ` | `Europe/London` | Default timezone for new lines |
| `RELAY_CONFIG_FILE` | `/data/config.json` | Lines and the hashed dashboard password |
| `RELAY_STATE_FILE` | `/data/relay-state.json` | Persisted stream ids |

`RELAY_PORTAL`, `RELAY_MAC` and `RELAY_PASSWORD` are read **once**, on a first run with no
configuration, to import an existing single-line setup. After that they're ignored.

## Security

The dashboard can read and write subscription credentials. It is built for a **local network**:
authentication is one password over plain HTTP, and `config.json` is written 0600 with the admin
password stored as a scrypt hash.

If you need access from outside, use a VPN rather than forwarding ports. Anyone who reaches a line's
port can stream it, and anyone who reaches the dashboard can read the portal credentials outright.

## Tests

```bash
node test-relay.js       # session sharing, fan-out, budget, id stability, dropped sources
node test-dashboard.js   # admin auth, line CRUD, per-line ports and password isolation
```

Both run against a mock portal — no real subscription needed.

## History

This started as **stalkerhek_plus**, a Go fork of
[stalkerhek](https://github.com/erkexzcx/stalkerhek). The relay is a fresh implementation with a
different goal: rather than proxying a portal for one client, it holds the single session centrally
so several devices can share one subscription.
