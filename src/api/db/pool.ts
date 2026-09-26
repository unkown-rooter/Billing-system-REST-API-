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
