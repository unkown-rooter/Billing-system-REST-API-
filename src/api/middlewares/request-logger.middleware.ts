import { Request, Response, NextFunction } from 'express';
import { redactSensitiveUrl, stripControlChars } from '../security/redaction.js';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    const elapsed = Date.now() - startTime;
    const safeMethod = stripControlChars(req.method);
    const safeUrl = redactSensitiveUrl(req.originalUrl || req.url);
    // Format: [2026-09-24T...] GET /api/v1/customers 200 (4ms)
    console.log(`[${new Date().toISOString()}] ${safeMethod} ${safeUrl} ${res.statusCode} (${elapsed}ms)`);
  });

  next();
}
