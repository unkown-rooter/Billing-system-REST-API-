import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Runs all pending SQL migrations found in the migrations directory.
 * Tracks applied migrations in the `schema_migrations` table.
 */
export async function runMigrations(customConnectionString?: string): Promise<MigrationResult> {
  const connectionString = customConnectionString || process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('Cannot run migrations: DATABASE_URL is not set.');
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
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

    // 3. Locate migration files in /migrations
    const migrationsDir = path.resolve(process.cwd(), 'migrations');
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
  } finally {
    client.release();
    await pool.end();
  }
}

// Allow direct execution from command line via tsx/node
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
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
