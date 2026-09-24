import { Request, Response } from 'express';
import { testConnection } from '../db/pool.js';

export class HealthController {
  constructor(private readonly dbCheck: () => Promise<boolean> = testConnection) {}

  getHealth = async (_req: Request, res: Response): Promise<void> => {
    const isDbHealthy = await this.dbCheck();

    if (!isDbHealthy) {
      res.status(503).json({
        status: 'error',
        data: {
          status: 'degraded',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          database: {
            status: 'unhealthy',
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
        },
      },
    });
  };
}
