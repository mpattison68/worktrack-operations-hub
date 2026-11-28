# Multi-stage production Dockerfile for WorkTrack (self-hosted Linux VM)
# Builds with build-time public Supabase URL/Anon key (never service role key).
# Sets NITRO_PRESET=node-server so the container outputs a standalone Node.js
# server (.output/server/index.mjs) instead of the default Cloudflare Worker target.

FROM node:22-alpine AS builder
WORKDIR /app

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV NITRO_PRESET=node-server
ENV NODE_OPTIONS=--max-old-space-size=2048

ARG BUN_VERSION=1.4.4
COPY package.json bun.lock bunfig.toml ./
RUN npm install -g bun@${BUN_VERSION} && bun install --frozen-lockfile
COPY . .
RUN npm run build
# Ensure VitePWA service worker artifacts are present in Nitro's public output dir
RUN if [ -d /app/dist/client ]; then \
      cp -f /app/dist/client/sw.js /app/.output/public/ 2>/dev/null || true; \
      cp -f /app/dist/client/workbox-*.js /app/.output/public/ 2>/dev/null || true; \
    fi

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=builder --chown=node:node /app/.output ./.output

USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/auth >/dev/null 2>&1 || exit 1

CMD ["node", ".output/server/index.mjs"]