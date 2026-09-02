# Dependency-free Node — there is no npm install step, so the image builds offline and in seconds.
FROM node:20-alpine

# ffmpeg is optional; it is only used to remux awkward containers. Without it the relay still
# streams everything the provider serves directly.
RUN apk add --no-cache ffmpeg wget

WORKDIR /app

COPY *.js ./
COPY package.json ./

ENV RELAY_PORT=4700 \
    RELAY_CONFIG_FILE=/data/config.json \
    RELAY_PROFILES_FILE=/data/profiles.json \
    RELAY_STATE_FILE=/data/relay-state.json \
    RELAY_CATALOG_FILE=/data/relay-catalog.json \
    RELAY_PORT_MIN=4701 \
    RELAY_PORT_MAX=4720 \
    NODE_ENV=production \
    # A very large line (100k+ catalogue items across live/films/series) holds the whole listing in
    # memory so devices never pay for a page-walk. That plus serialisation spikes on state-save can
    # exceed Node's ~2GB default heap while warming. Give it headroom; raise further for huge lines.
    NODE_OPTIONS=--max-old-space-size=4096

# Stream ids and the portal catalogue live here. Without a volume, every restart reissues ids and
# breaks the favourites your players have already saved.
VOLUME ["/data"]
# 4700 is the dashboard and the shared endpoint; the rest are claimable by individual lines.
EXPOSE 4700 4701-4720

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4700/health || exit 1

CMD ["node", "server.js"]
