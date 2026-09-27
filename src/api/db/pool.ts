import pg from 'pg';
import 'dotenv/config';
import { redactSensitiveText } from '../security/redaction.js';

const { Pool } = pg;

export interface PoolConfig {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
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

/**
 * Returns or initializes the shared PostgreSQL connection pool.
 * Configured via the DATABASE_URL environment variable.
 */
export function getPool(customConfig?: PoolConfig): pg.Pool {
  if (!activePool) {
    const connectionString = customConfig?.connectionString || process.env.DATABASE_URL;

    if (!connectionString) {
      console.warn('[DATABASE] DATABASE_URL is not set. Database operations will fail until configured.');
    }

    activePool = new Pool({
      connectionString,
      max: customConfig?.max ?? 10,
      idleTimeoutMillis: customConfig?.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: customConfig?.connectionTimeoutMillis ?? 5000,
    });

    activePool.on('error', (err: Error) => {
      console.error('[DATABASE POOL] Unexpected error on idle client:', redactSensitiveText(err.message));
    });
  }

  return activePool;
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
    console.error('[DATABASE] Connectivity check failed:', redactSensitiveText(errorMessage));
    return false;
  }
}

/**
 * Gracefully shuts down the connection pool, draining active clients.
 */
export async function closePool(): Promise<void> {
  if (activePool) {
    console.log('[DATABASE POOL] Draining and closing database pool...');
    await activePool.end();
    activePool = null;
    console.log('[DATABASE POOL] Pool closed.');
  }
}
