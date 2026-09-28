import { Request, Response, NextFunction } from 'express';
import { TokenService } from '../services/token.service.js';
import {
  AuthenticationRequiredError,
  InvalidTokenError,
  TokenExpiredError,
} from '../services/errors.js';
import { logger } from '../observability/logger.js';
import { metricsCollector } from '../observability/metrics.js';

export interface AuthenticateMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
}

/**
 * Creates authentication middleware backed by the provided TokenService.
 * Enforces RFC 6750 Bearer token authentication in the Authorization header.
 * 
 * Verifications:
 * - Rejects missing Authorization header (401 AUTHENTICATION_REQUIRED)
 * - Rejects non-Bearer schemes (401 INVALID_TOKEN)
 * - Rejects empty/whitespace tokens (401 INVALID_TOKEN)
 * - Rejects malformed or tampered signatures (401 INVALID_TOKEN)
 * - Rejects expired tokens (401 TOKEN_EXPIRED)
 * - Attaches safe AuthenticatedUser { id, email } to req.user
 */
export function createAuthMiddleware(tokenService: TokenService): AuthenticateMiddleware {
  return function authenticate(req: Request, _res: Response, next: NextFunction): void {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        throw new AuthenticationRequiredError('Authentication is required. Missing Authorization header');
      }

      const parts = authHeader.trim().split(' ');
      if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
        throw new InvalidTokenError('Invalid Authorization header format. Expected Bearer scheme: "Authorization: Bearer <token>"');
      }

      const token = parts[1].trim();
      if (!token) {
        throw new InvalidTokenError('Authentication token cannot be empty');
      }

      const payload = tokenService.verifyToken(token);

      req.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };

      next();
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        metricsCollector.recordSecurityEvent('authTokenExpired');
        logger.warn('auth_token_expired', err.message, {
          path: req.originalUrl || req.url,
          method: req.method,
        });
      } else if (err instanceof InvalidTokenError) {
        metricsCollector.recordSecurityEvent('authTokenInvalid');
        logger.warn('auth_token_invalid', err.message, {
          path: req.originalUrl || req.url,
          method: req.method,
        });
      }
      next(err);
    }
  };
}
