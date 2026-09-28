import { Request, Response } from 'express';
import pg from 'pg';
import { testConnection, getPoolStats } from '../db/pool.js';
import { logger } from '../observability/logger.js';
import { metricsCollector } from '../observability/metrics.js';

export class HealthController {
  constructor(
    private readonly dbCheck: () => Promise<boolean> = testConnection,
    private readonly pool?: pg.Pool
  ) {}

  getHealth = async (_req: Request, res: Response): Promise<void> => {
    const startMs = Date.now();
    let isDbHealthy = false;
    try {
      isDbHealthy = await this.dbCheck();
    } catch {
      isDbHealthy = false;
    }
    const latencyMs = Math.max(0, Date.now() - startMs);
    const poolStats = getPoolStats(this.pool);

    if (!isDbHealthy) {
      logger.warn('health_check_degraded', 'Health check reported degraded state: database unhealthy', {
        databaseStatus: 'unhealthy',
        latencyMs,
      });

      res.status(503).json({
        status: 'error',
        data: {
          status: 'degraded',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          database: {
            status: 'unhealthy',
            latencyMs,
            pool: poolStats,
          },
        },
      });
      return;
    }

    res.status(200).json({
      status: 'success',
      data: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          status: 'healthy',
          latencyMs,
          pool: poolStats,
        },
      },
    });
  };

  getLiveness = (_req: Request, res: Response): void => {
    res.status(200).json({
      status: 'success',
      data: {
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      },
    });
  };

  getReadiness = async (req: Request, res: Response): Promise<void> => {
    await this.getHealth(req, res);
  };

  getMetrics = (_req: Request, res: Response): void => {
    res.status(200).json({
      status: 'success',
      data: {
        ...metricsCollector.getSnapshot(),
        databasePool: getPoolStats(this.pool),
      },
    });
  };
}
