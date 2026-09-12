# Varadhi backend
# -----------------------------------------------------------------------------
# Multi-stage so the runtime image carries production dependencies only — the
# dev toolchain (eslint, nodemon, node-pg-migrate's dev tree) never ships.
#
# NO SECRETS AT ANY LAYER. Every credential arrives as an environment variable
# at run time. Nothing is COPY-ed in, no ARG carries a value, and .dockerignore
# excludes .env* so a stray local file cannot be baked into a layer — a secret
# in an image layer survives deletion from the final filesystem and travels with
# every copy of the image.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
# package files alone, so the dependency layer is cached until they change
# rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── build (dev deps, for lint/test in CI) ────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# dumb-init gives PID 1 real signal handling. Without it, node runs as PID 1,
# does not get default SIGTERM behaviour, and `docker stop` waits the full
# timeout before killing it — which also means the cron leader never releases
# its advisory lock cleanly on a deploy.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
# Containers are read by a log collector, not a terminal.
ENV LOG_FORMAT=json

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts

# node:alpine ships an unprivileged `node` user. Running as root inside a
# container is the default and is worth undoing: a process escape lands on a
# user that owns nothing.
USER node

EXPOSE 5000

# Liveness only — /health deliberately touches no dependency, so a database
# outage does not restart-loop every container in the fleet. Readiness
# (/health/ready) is the load balancer's business, not the runtime's.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
