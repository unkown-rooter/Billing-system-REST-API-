# ============================================================================
# Billing System REST API — Phase 10 Multi-Stage Production Dockerfile
# ============================================================================
# Stage 1 (builder): Installs build dependencies, validates TypeScript types,
#                    and compiles frontend assets (dist/) + backend server (dist-server/).
# Stage 2 (runtime): Minimal Node.js 22 runtime with production-only dependencies,
#                    compiled JavaScript artifacts, SQL migrations, non-root user (`node`),
#                    truthful HTTP/PostgreSQL HEALTHCHECK, and exec-form SIGTERM startup.
# ============================================================================

# ----------------------------------------------------------------------------
# Stage 1: Build & Typecheck Stage
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching
COPY package.json ./

# Install dependencies (including devDependencies required for tsc and vite build)
RUN npm install --no-audit --no-fund

# Copy TypeScript configs, application source, and frontend entry points
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html server.ts ./
COPY public ./public
COPY src/api ./src/api
COPY src/App.tsx src/main.tsx src/index.css ./src/

# Verify strict TypeScript compilation and produce dist/ + dist-server/
RUN npm run lint && npm run build

# ----------------------------------------------------------------------------
# Stage 2: Minimal Production Runtime Stage
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# Set production environment defaults (secrets such as DATABASE_URL and JWT_SECRET
# MUST be injected at container runtime via `docker run -e`, never hardcoded here)
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Install production-only dependencies and clean npm cache in a single layer
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && chown -R node:node /app

# Copy only compiled production artifacts and SQL migration files from builder
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/dist-server ./dist-server
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node .env.example ./.env.example

# Drop root privileges: run application as the built-in non-root `node` user (UID 1000)
USER node

# Document internal container listening port
EXPOSE 3000

# Truthful application & PostgreSQL connectivity healthcheck using built-in Node fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Use exec form so `node` runs as PID 1 and receives SIGTERM directly for graceful shutdown
CMD ["node", "dist-server/server.js"]
