import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { createApp } from './src/api/app.js';
import { closePool } from './src/api/db/pool.js';
import { logger, resolveConfiguredLogLevel } from './src/api/observability/logger.js';
import { redactSensitiveText } from './src/api/security/redaction.js';

async function startServer(): Promise<void> {
  const app = createApp();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';

  // Mount Vite dev middleware in local source development; serve compiled dist/ in production or container runtime
  const hasRootIndexHtml = fs.existsSync(path.resolve(process.cwd(), 'index.html'));
  if (process.env.NODE_ENV !== 'production' && hasRootIndexHtml) {
    const { createServer: createViteServer } = await import('vite');
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

  const keepAliveTimeoutMs = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS) || 65_000;
  const headersTimeoutMs =
    Number(process.env.HTTP_HEADERS_TIMEOUT_MS) || Math.max(keepAliveTimeoutMs + 1_000, 66_000);
  const requestTimeoutMs = Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 30_000;

  const server = app.listen(PORT, HOST, () => {
    logger.info(
      'server_started',
      `Billing System REST API listening at http://${HOST}:${PORT}`,
      {
        phase: 14,
        domain: 'Developer Readiness & Public API Release',
        host: HOST,
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        logLevel: resolveConfiguredLogLevel(),
        keepAliveTimeoutMs,
        requestTimeoutMs,
        healthEndpoint: `/api/v1/health`,
        metricsEndpoint: `/api/v1/metrics`,
      }
    );
  });

  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;

  // Graceful shutdown handling
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(
      'server_shutdown_initiated',
      `[PROCESS] Received ${signal}. Shutting down server gracefully...`,
      { signal }
    );

    // Enforce shutdown timeout if connections or pool drains are kept alive
    const timeoutHandle = setTimeout(() => {
      logger.error('server_shutdown_timeout', '[PROCESS] Shutdown timed out after 5s. Forcing exit.');
      process.exit(1);
    }, 5000);
    timeoutHandle.unref();

    // 1. Stop accepting new HTTP connections and close idle keep-alive sockets
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    server.close(async (err) => {
      if (err) {
        logger.error(
          'server_http_close_error',
          `[PROCESS] Error closing HTTP server: ${redactSensitiveText(err.message)}`,
          { error: redactSensitiveText(err.message) }
        );
      } else {
        logger.info('server_http_closed', '[PROCESS] HTTP server closed cleanly.');
      }

      // 2. Close PostgreSQL connection pool
      try {
        await closePool();
      } catch (poolErr) {
        const msg = poolErr instanceof Error ? poolErr.message : String(poolErr);
        logger.error(
          'db_pool_close_error',
          `[PROCESS] Error closing database pool: ${redactSensitiveText(msg)}`,
          { error: redactSensitiveText(msg) }
        );
      }

      process.exit(err ? 1 : 0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('process_unhandled_rejection', `[PROCESS] Unhandled Promise Rejection: ${redactSensitiveText(msg)}`, {
      error: redactSensitiveText(msg),
    });
  });

  process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('process_uncaught_exception', `[PROCESS] Uncaught Exception: ${redactSensitiveText(msg)}`, {
      error: redactSensitiveText(msg),
    });
    process.exit(1);
  });
}

startServer().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error('server_startup_failed', `Failed to start server: ${redactSensitiveText(msg)}`, {
    error: redactSensitiveText(msg),
  });
  process.exit(1);
});
