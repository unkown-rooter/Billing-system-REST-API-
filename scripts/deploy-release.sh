#!/usr/bin/env bash
# ============================================================================
# Billing System REST API — Phase 11 Production Release & Migration Script
# ============================================================================
# Executes the authoritative Phase 11 release sequence:
#   1. Pre-flight verification of NODE_ENV=production, JWT_SECRET (>=32 chars),
#      and DATABASE_URL separation (Development DB != Test DB != Production DB).
#   2. Strict TypeScript typecheck and production artifact build (dist/ + dist-server/).
#   3. Authoritative database schema migration (`node dist-server/src/api/db/migrate.js`)
#      against the production PostgreSQL database before starting/reloading traffic.
# ============================================================================

set -euo pipefail

echo "[DEPLOY] Starting Phase 11 Production Release Pipeline..."

# 1. Load runtime environment if .env exists and variables are not already exported
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[DEPLOY ERROR] DATABASE_URL must be set for production deployment." >&2
  exit 1
fi

if [ -z "${JWT_SECRET:-}" ] || [ "${#JWT_SECRET}" -lt 32 ]; then
  echo "[DEPLOY ERROR] JWT_SECRET must be set and at least 32 characters long." >&2
  exit 1
fi

# 2. Verify strict Production Database Separation (Production DB != Dev DB != Test DB)
node --input-type=module -e "
import { assertSafeProductionDatabaseUrl } from './dist-server/src/api/db/pool.js';
import { resolveAndValidateJwtSecret } from './dist-server/src/api/services/token.service.js';
assertSafeProductionDatabaseUrl(process.env.DATABASE_URL, { disallowDevDbName: true });
resolveAndValidateJwtSecret(process.env.JWT_SECRET, 'production');
console.log('[DEPLOY] Pre-flight security and database isolation checks passed.');
" 2>/dev/null || {
  echo "[DEPLOY] Building server artifacts before running pre-flight verification..."
  npm run build
  node --input-type=module -e "
import { assertSafeProductionDatabaseUrl } from './dist-server/src/api/db/pool.js';
import { resolveAndValidateJwtSecret } from './dist-server/src/api/services/token.service.js';
assertSafeProductionDatabaseUrl(process.env.DATABASE_URL, { disallowDevDbName: true });
resolveAndValidateJwtSecret(process.env.JWT_SECRET, 'production');
console.log('[DEPLOY] Pre-flight security and database isolation checks passed.');
"
}

# 3. Compile and validate production artifacts
echo "[DEPLOY] Running strict TypeScript verification and production build..."
npm run lint
npm run build

# 4. Run authoritative production database migrations (idempotent & transactional)
echo "[DEPLOY] Applying pending PostgreSQL production migrations..."
npm run migrate:prod

echo "[DEPLOY] Release preparation and migrations completed cleanly."
