import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const MIGRATION_ADVISORY_LOCK_ID = 748392015;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface MigrationQueryClient {
  query<T extends pg.QueryResultRow = any>(
    queryText: string,
    values?: unknown[]
  ): Promise<pg.QueryResult<T>>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationQueryClient>;
  end(): Promise<void>;
}

export interface RunMigrationsOptions {
  migrationsDir?: string;
  pool?: MigrationPool;
  lockId?: number;
}

/**
 * Runs all pending SQL migrations found in the migrations directory.
 * Coordinates concurrent deployments using a PostgreSQL session-level advisory lock
 * (`pg_advisory_lock` / `pg_advisory_unlock`) and tracks applied migrations in the
 * `schema_migrations` table with an atomic transaction per migration file.
 */
export async function runMigrations(
  customConnectionString?: string,
  options?: RunMigrationsOptions
): Promise<MigrationResult> {
  const connectionString = customConnectionString || process.env.DATABASE_URL;

  if (!options?.pool && !connectionString) {
    throw new Error('Cannot run migrations: DATABASE_URL is not set.');
  }

  const ownsPool = !options?.pool;
  const pool: MigrationPool = options?.pool ?? new Pool({ connectionString });
  const lockId = options?.lockId ?? MIGRATION_ADVISORY_LOCK_ID;
  const client = await pool.connect();

  let lockAcquired = false;
  let executionError: unknown = null;

  try {
    // 0. Acquire exclusive session-level PostgreSQL advisory lock to serialize concurrent runners
    await client.query('SELECT pg_advisory_lock($1);', [lockId]);
    lockAcquired = true;

    // 1. Ensure the schema_migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Query already applied migrations
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY id ASC;'
    );
    const appliedSet = new Set(rows.map((r) => r.name));

    // 3. Locate migration files in /migrations (or custom directory)
    const migrationsDir = options?.migrationsDir ?? path.resolve(process.cwd(), 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.log('[MIGRATE] No migrations directory found at', migrationsDir);
      return { applied: [], alreadyApplied: Array.from(appliedSet) };
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const newlyApplied: string[] = [];
    const alreadyApplied: string[] = [];

    // 4. Execute pending migrations sequentially in transactions
    for (const file of files) {
      if (appliedSet.has(file)) {
        alreadyApplied.push(file);
        continue;
      }

      console.log(`[MIGRATE] Applying migration: ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1);',
          [file]
        );
        await client.query('COMMIT');
        newlyApplied.push(file);
        console.log(`[MIGRATE] Successfully applied: ${file}`);
      } catch (migrationErr) {
        await client.query('ROLLBACK');
        console.error(`[MIGRATE] Failed to apply migration '${file}'. Rolled back.`);
        throw migrationErr;
      }
    }

    if (newlyApplied.length === 0) {
      console.log('[MIGRATE] Database schema is already up to date.');
    } else {
      console.log(`[MIGRATE] Migrations completed. ${newlyApplied.length} new migration(s) applied.`);
    }

    return {
      applied: newlyApplied,
      alreadyApplied,
    };
  } catch (err) {
    executionError = err;
    throw err;
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1);', [lockId]);
      }
    } catch (unlockErr) {
      console.error('[MIGRATE] Failed to release PostgreSQL advisory lock:', unlockErr);
      if (!executionError) {
        throw unlockErr;
      }
    } finally {
      client.release();
      if (ownsPool) {
        await pool.end();
      }
    }
  }
}

// Allow direct execution from command line via node (compiled migrate.js) or tsx (migrate.ts)
if (
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'))
) {
  runMigrations()
    .then(() => {
      console.log('[MIGRATE] Migration process exited cleanly.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[MIGRATE] Migration process failed:', err);
      process.exit(1);
    });
}
