import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    const elapsed = Date.now() - startTime;
    // Format: [2026-09-24T...] GET /api/v1/customers 200 (4ms)
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} (${elapsed}ms)`);
  });

  next();
}
