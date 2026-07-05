# syntax=docker/dockerfile:1

# ============================================================
# wacrm — production image for EasyPanel (and any Docker host)
#
# Next.js 16 with `output: "standalone"`. Multi-stage build so the
# runtime image ships only the traced server bundle + static assets,
# never the full dev dependency tree or the source.
#
# Runtime env vars (Supabase service key, ENCRYPTION_KEY, META_APP_SECRET,
# etc.) are injected by EasyPanel at run time. The NEXT_PUBLIC_* vars are
# the exception: they are inlined into the browser bundle during the build,
# so they are declared as build ARGs below. See docs/deploy-easypanel.md.
# ============================================================

# --- Base -------------------------------------------------------------------
# libc6-compat lets the odd native dependency find glibc symbols on musl/alpine.
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# --- Dependencies -----------------------------------------------------------
# Reproducible install straight from the lockfile. This layer is cached until
# package.json or package-lock.json changes.
#
# npm is pinned to the version that generated package-lock.json. npm 10 and 11
# compute different dependency trees for some transitive packages (the
# @emnapi/* wasm helpers pulled in by Tailwind v4's oxide), so `npm ci` — which
# is strict — only accepts a lockfile produced by a matching npm major.
# node:22-alpine ships npm 10.x, while the committed lockfile is built with
# npm 11.6.1; without this pin `npm ci` aborts with "packages ... not in sync".
# If you regenerate the lockfile with a different npm, bump this to match.
FROM base AS deps
RUN npm i -g npm@11.6.1
COPY package.json package-lock.json ./
RUN npm ci

# --- Builder ----------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* are baked into the client bundle at build time — they MUST be
# present here, not only at runtime. EasyPanel forwards the service's env vars
# as build args, so declaring them as ARG picks up whatever you set in the
# "Environment" tab. Missing ones fall back to empty (the browser Supabase
# client would then be misconfigured), so set at least the two Supabase vars.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN npm run build

# --- Runner -----------------------------------------------------------------
FROM base AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Drop root: the app runs as an unprivileged user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# The standalone bundle already contains server.js + traced node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# standalone does NOT bundle these two — copy them next to server.js so it
# can serve hashed assets (.next/static) and files under public/.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

# The app listens on $PORT (default 3000) — EasyPanel may override it at
# runtime, and the standalone server honours whatever value it gets. Make sure
# the port EasyPanel's proxy forwards to matches this value. HOSTNAME=0.0.0.0
# (set above) is required so the server binds all interfaces; binding to
# localhost would leave it unreachable from the reverse proxy.
EXPOSE 3000

# No Docker HEALTHCHECK on purpose. EasyPanel already health-checks the app
# through its HTTP proxy. A container-level healthcheck pinned to a fixed port
# fails — and makes Docker Swarm kill and reschedule the task in a restart
# loop — whenever EasyPanel runs the app on a different PORT than the one
# hardcoded here.

# server.js is the minimal server emitted by output: "standalone".
CMD ["node", "server.js"]
