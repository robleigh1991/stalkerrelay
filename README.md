# STB Player Relay

One portal, many devices.

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
                                  ┌─────────────┐
   phone  ─┐                      │             │
   desktop ─┼── Xtream ──▶  relay ─┼── 1 session ─┼──▶  portal
   TV      ─┘                      │             │
                                  └─────────────┘
```

## Deploying with Portainer

**Stacks → Add stack → Repository**

| Field | Value |
|---|---|
| Repository URL | `https://github.com/robleigh1991/stalkerhek_plus` |
| Reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |

Then add these under **Environment variables**:

| Name | Example | Notes |
|---|---|---|
| `RELAY_PORTAL` | `http://line.example.net/portal.php` | Portal URL |
| `RELAY_MAC` | `00:1A:79:F2:B1:5D` | The MAC to share |
| `RELAY_MAX_CONNECTIONS` | `2` | What your line actually allows |
| `RELAY_PASSWORD` | *something of your own* | Devices log in with this |
| `RELAY_PORT` | `4700` | Host port, optional |
| `RELAY_EPG_URL` | | Optional external XMLTV |

Enable **Automatic updates** if you want Portainer to redeploy when you push.

Credentials go in Portainer, never in the repo — the portal URL and MAC *are* the subscription.

### Or plain compose

```bash
cp .env.example .env    # fill in portal + mac
docker compose up -d --build
```

### Or no Docker at all

```bash
RELAY_PORTAL=http://... RELAY_MAC=00:1A:79:... node server.js
```

Node 18+, no dependencies to install.

## Pointing devices at it

Any Xtream-capable player — TiviMate, OTT Navigator, VLC, STB Player itself:

| Field | Value |
|---|---|
| Server | `http://<host>:4700` |
| Username | the **MAC** (`00:1A:79:F2:B1:5D`) |
| Password | your `RELAY_PASSWORD` |

Or the playlist directly:

```
http://<host>:4700/get.php?username=<MAC>&password=<pass>
http://<host>:4700/xmltv.php?username=<MAC>&password=<pass>
```

> **While testing, don't leave another client connected to the same MAC.** It will handshake
> directly against the portal and evict the relay's session — the exact problem this exists to
> solve. Quit it, or give the relay its own MAC.

## Sharing several lines

Put a `profiles.json` in the volume (`/data/profiles.json`) and drop `RELAY_PORTAL`/`RELAY_MAC`:

```json
[
  { "id": "1", "name": "Main",   "portal": "http://a/portal.php", "mac": "00:1A:79:AA:AA:AA", "maxConnections": 2 },
  { "id": "2", "name": "Backup", "portal": "http://b/portal.php", "mac": "00:1A:79:BB:BB:BB", "maxConnections": 1 }
]
```

Each device logs in with the MAC of the line it wants.

## Endpoints

| Path | Purpose |
|---|---|
| `/player_api.php` | Xtream API — live, VOD, series, categories, `get_series_info`, short EPG |
| `/get.php` | M3U playlist |
| `/xmltv.php` | EPG as XMLTV |
| `/live/<mac>/<pass>/<id>.ts` | live stream, fanned out between devices |
| `/movie/<mac>/<pass>/<id>.mp4` | film, resumable by byte offset |
| `/series/<mac>/<pass>/<id>.mp4` | episode, resumable by byte offset |
| `/status` | sessions, connections in use, what's playing |
| `/health` | container health check |

`/status` is the one to look at when something seems wrong — it shows the live session, how many
connections are held, and by whom.

## Behaviour worth knowing

**Stream ids are stable.** They're keyed on the portal command and persisted to
`/data/relay-state.json`, so favourites survive restarts and a play URL issued an hour ago still
resolves. Ids do *not* shift when categories are filtered — deriving them from a filtered listing
is how you end up playing the wrong channel. **Keep the volume**; losing it reissues every id.

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

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_PORT` | `4700` | Listen port |
| `RELAY_PORTAL` | — | Portal URL (single-line mode) |
| `RELAY_MAC` | — | MAC (single-line mode) |
| `RELAY_MAX_CONNECTIONS` | `2` | The line's concurrent-stream cap |
| `RELAY_PASSWORD` | `stbplayer` | Password devices use |
| `RELAY_TZ` | `Europe/London` | Portal timezone |
| `RELAY_EPG_URL` | — | External XMLTV; otherwise built from the portal |
| `RELAY_PROFILES_FILE` | `/data/profiles.json` | Multi-line config |
| `RELAY_STATE_FILE` | `/data/relay-state.json` | Persisted stream ids |

## Tests

```bash
node test-relay.js
```

Runs the relay against a mock portal and a mock media origin, covering session sharing, fan-out,
connection-budget exhaustion, id round-tripping and persistence, "All" listings, live re-open
through repeated drops, and auth.

## History

This repository previously held **stalkerhek_plus**, a Go fork of
[stalkerhek](https://github.com/erkexzcx/stalkerhek). That code remains in the git history. The
relay is a fresh implementation with a different goal: rather than proxying a portal for one client,
it holds the single session centrally so several devices can share one subscription.
