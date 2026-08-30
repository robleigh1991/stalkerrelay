# Security

## What is sensitive here

The **portal URL and MAC address are the subscription credentials.** Anyone holding both can use
the line. Treat them the way you'd treat a password:

- Keep them in Portainer's environment variables or a local `.env` — both are outside the repo.
- `.env` and `profiles.json` are gitignored and excluded from the Docker image.
- Don't paste them into issues, logs or screenshots.

## Exposing the relay

The relay is built for a **local network**. Its authentication is a single shared password over
plain HTTP, which is what Xtream clients expect — it is not designed to face the internet.

If you need access from outside, put it behind a VPN (WireGuard, Tailscale) rather than forwarding
port 4700. If you forward it anyway, at minimum set a long `RELAY_PASSWORD` and terminate TLS in
front of it with a reverse proxy.

Anyone who reaches the relay can stream your line — and, because the relay holds the session, they
don't need the portal credentials to do it.

## Reporting a problem

Open an issue at https://github.com/robleigh1991/stalkerhek_plus/issues. For anything that would
expose credentials, use a private security advisory rather than a public issue.
