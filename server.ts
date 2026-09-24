import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { createApp } from './src/api/app.js';
import { closePool } from './src/api/db/pool.js';
import { createServer as createViteServer } from 'vite';

async function startServer(): Promise<void> {
  const app = createApp();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = '0.0.0.0';

  // Mount Vite dev middleware in development; serve static dist files in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
    }
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`===============================================`);
    console.log(` Billing System REST API running in Phase 2`);
    console.log(` Persistence: PostgreSQL Database`);
    console.log(` Server listening at http://${HOST}:${PORT}`);
    console.log(` Health check: http://${HOST}:${PORT}/api/v1/health`);
    console.log(` Customers:    http://${HOST}:${PORT}/api/v1/customers`);
    console.log(`===============================================`);
  });

  // Graceful shutdown handling
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[PROCESS] Received ${signal}. Shutting down server gracefully...`);

    // Enforce shutdown timeout if connections or pool drains are kept alive
    const timeoutHandle = setTimeout(() => {
      console.error('[PROCESS] Shutdown timed out after 5s. Forcing exit.');
      process.exit(1);
    }, 5000);
    timeoutHandle.unref();

    // 1. Stop accepting new HTTP connections
    server.close(async (err) => {
      if (err) {
        console.error('[PROCESS] Error closing HTTP server:', err);
      } else {
        console.log('[PROCESS] HTTP server closed cleanly.');
      }

      // 2. Close PostgreSQL connection pool
      try {
        await closePool();
      } catch (poolErr) {
        console.error('[PROCESS] Error closing database pool:', poolErr);
      }

      process.exit(err ? 1 : 0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('[PROCESS] Unhandled Promise Rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[PROCESS] Uncaught Exception:', err);
    process.exit(1);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
