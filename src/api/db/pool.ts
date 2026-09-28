import pg from 'pg';
import 'dotenv/config';
import { redactSensitiveText } from '../security/redaction.js';
import { logger } from '../observability/logger.js';

const { Pool } = pg;

export interface PoolConfig {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
}

export interface DatabasePoolStats {
  max: number;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  activeCount: number;
}

function parsePositiveIntEnv(envVal: string | undefined, fallback: number): number {
  if (!envVal) return fallback;
  const parsed = Number.parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolvePoolConfig(customConfig?: PoolConfig): Required<Omit<PoolConfig, 'connectionString'>> & {
  connectionString?: string;
} {
  return {
    connectionString: customConfig?.connectionString || process.env.DATABASE_URL,
    max: customConfig?.max ?? parsePositiveIntEnv(process.env.DB_POOL_MAX, 10),
    idleTimeoutMillis:
      customConfig?.idleTimeoutMillis ?? parsePositiveIntEnv(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis:
      customConfig?.connectionTimeoutMillis ??
      parsePositiveIntEnv(process.env.DB_POOL_CONNECTION_TIMEOUT_MS, 5_000),
    statementTimeoutMillis:
      customConfig?.statementTimeoutMillis ??
      parsePositiveIntEnv(process.env.DB_STATEMENT_TIMEOUT_MS, 10_000),
  };
}

export interface ProductionDatabaseValidationOptions {
  devDatabaseUrl?: string;
  testDatabaseUrl?: string;
  disallowDevDbName?: boolean;
}

/**
 * Validates that a production PostgreSQL connection string is a valid PostgreSQL URI
 * and is strictly isolated from test databases (`*_test`) and development databases.
 */
export function assertSafeProductionDatabaseUrl(
  prodDatabaseUrl: string,
  options: ProductionDatabaseValidationOptions = {}
): void {
  if (!prodDatabaseUrl || typeof prodDatabaseUrl !== 'string' || prodDatabaseUrl.trim().length === 0) {
    throw new Error(
      'Production isolation violation: DATABASE_URL must be a non-empty PostgreSQL connection string.'
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(prodDatabaseUrl.trim());
  } catch {
    throw new Error('Production isolation violation: DATABASE_URL is not a valid URI.');
  }

  if (parsedUrl.protocol !== 'postgresql:' && parsedUrl.protocol !== 'postgres:') {
    throw new Error(
      `Production isolation violation: Unsupported database protocol '${parsedUrl.protocol}'. Expected postgresql://.`
    );
  }

  const dbName = parsedUrl.pathname.replace(/^\//, '').trim();
  if (!dbName) {
    throw new Error('Production isolation violation: DATABASE_URL must specify a database name.');
  }

  if (dbName.endsWith('_test')) {
    throw new Error(
      `Production isolation violation: Production database '${dbName}' must never point to a test database ('*_test').`
    );
  }

  if (options.disallowDevDbName && dbName === 'billing_system') {
    throw new Error(
      `Production isolation violation: Production database '${dbName}' must be separated from the default local development database ('billing_system').`
    );
  }

  if (options.devDatabaseUrl && prodDatabaseUrl.trim() === options.devDatabaseUrl.trim()) {
    throw new Error(
      'Production isolation violation: Production DATABASE_URL must not be identical to development DATABASE_URL.'
    );
  }

  if (options.testDatabaseUrl && prodDatabaseUrl.trim() === options.testDatabaseUrl.trim()) {
    throw new Error(
      'Production isolation violation: Production DATABASE_URL must not be identical to TEST_DATABASE_URL.'
    );
  }
}

let activePool: pg.Pool | null = null;
let activePoolMax = 10;

/**
 * Returns or initializes the shared PostgreSQL connection pool.
 * Configured via DATABASE_URL, DB_POOL_MAX, DB_POOL_IDLE_TIMEOUT_MS,
 * DB_POOL_CONNECTION_TIMEOUT_MS, and DB_STATEMENT_TIMEOUT_MS.
 */
export function getPool(customConfig?: PoolConfig): pg.Pool {
  if (!activePool) {
    const resolved = resolvePoolConfig(customConfig);

    if (!resolved.connectionString) {
      logger.warn('db_config_missing', '[DATABASE] DATABASE_URL is not set. Database operations will fail until configured.');
    }

    activePoolMax = resolved.max;
    activePool = new Pool({
      connectionString: resolved.connectionString,
      max: resolved.max,
      idleTimeoutMillis: resolved.idleTimeoutMillis,
      connectionTimeoutMillis: resolved.connectionTimeoutMillis,
      statement_timeout: resolved.statementTimeoutMillis,
    });

    activePool.on('error', (err: Error) => {
      logger.error(
        'db_pool_error',
        `[DATABASE POOL] Unexpected error on idle client: ${redactSensitiveText(err.message)}`,
        { error: redactSensitiveText(err.message) }
      );
    });
  }

  return activePool;
}

/**
 * Returns current connection pool telemetry without initializing a new pool
 * if one has not been started.
 */
export function getPoolStats(poolInstance?: pg.Pool): DatabasePoolStats {
  const pool = poolInstance ?? activePool;
  const max = poolInstance
    ? ((poolInstance as unknown as { options?: { max?: number } }).options?.max ??
      resolvePoolConfig().max)
    : activePool
      ? activePoolMax
      : resolvePoolConfig().max;

  if (!pool) {
    return {
      max,
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      activeCount: 0,
    };
  }

  const totalCount = pool.totalCount ?? 0;
  const idleCount = pool.idleCount ?? 0;
  const waitingCount = pool.waitingCount ?? 0;
  const activeCount = Math.max(0, totalCount - idleCount);

  return {
    max,
    totalCount,
    idleCount,
    waitingCount,
    activeCount,
  };
}

/**
 * Executes a connectivity test (SELECT 1) against the database.
 * Returns true if connected, false otherwise. Never throws.
 */
export async function testConnection(poolInstance?: pg.Pool): Promise<boolean> {
  const pool = poolInstance || getPool();
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const safeMsg = redactSensitiveText(errorMessage);
    logger.error('db_health_check_failed', `[DATABASE] Connectivity check failed: ${safeMsg}`, {
      error: safeMsg,
    });
    return false;
  }
}

/**
 * Gracefully shuts down the connection pool, draining active clients.
 */
export async function closePool(): Promise<void> {
  if (activePool) {
    logger.info('db_pool_draining', '[DATABASE POOL] Draining and closing database pool...');
    await activePool.end();
    activePool = null;
    logger.info('db_pool_closed', '[DATABASE POOL] Pool closed.');
  }
}
