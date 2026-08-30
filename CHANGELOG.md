# Changelog

## 1.0.0

The repository changes implementation. It previously held **stalkerhek_plus**, a Go fork of
stalkerhek; it now holds the **STB Player Relay**, a dependency-free Node service. The Go source
remains in the git history.

The goal changed too. stalkerhek proxies a portal for a client. The relay holds the portal's single
session centrally, so several devices can share one subscription without evicting each other.

### Added

- Single shared portal session, kept warm and re-authenticated on expiry, so devices never handshake
  against the portal themselves.
- Xtream Codes façade — `player_api.php`, `get.php`, `xmltv.php` — usable by TiviMate, OTT
  Navigator, VLC and STB Player.
- Connection leasing that enforces the line's concurrent-stream cap locally and returns a readable
  503, instead of a bare portal 456 arriving mid-playback.
- Fan-out: several devices on one channel consume one upstream connection.
- Stream ids keyed on the portal command and persisted, so saved favourites survive restarts and
  do not shift when categories are filtered.
- Live streams re-open and append after a dropped source; files resume by byte offset and refuse a
  200-from-zero, which would splice the opening into the middle.
- EPG from an external XMLTV URL, or built from the portal's short-EPG.
- Multi-line support via `profiles.json`.
- Test suite running the relay against a mock portal and mock media origin.
