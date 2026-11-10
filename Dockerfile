# Multi-arch friendly (amd64 VPS, arm64 Oracle Ampere / Raspberry Pi): @napi-rs/canvas ships prebuilt binaries for both.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
# CJK fonts so Korean/Japanese/Chinese names render in scoreboard images
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/app/data/leaguebot.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY assets ./assets
# Data lives in /app/data. Mount persistent storage there:
#  - docker compose: ./data:/app/data (see docker-compose.yml)
#  - Railway: add a Volume with mount path /app/data
# (No VOLUME/USER lines: Railway rejects VOLUME and mounts volumes as root.)
RUN mkdir -p /app/data
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
