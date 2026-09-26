import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthController } from '../controllers/auth.controller.js';
import { AuthenticateMiddleware } from '../middlewares/auth.middleware.js';
import { validateRegisterBody, validateLoginBody } from '../validation/auth.schema.js';
import { createAuthRateLimiter } from '../middlewares/rate-limit.middleware.js';
import { methodNotAllowed } from '../middlewares/method-not-allowed.middleware.js';

export function createAuthRouter(
  authController: AuthController,
  authenticate: AuthenticateMiddleware,
  authRateLimiter?: RequestHandler
): Router {
  const router = Router();
  const limiter = authRateLimiter ?? createAuthRateLimiter();

  // Registration Validation Middleware
  const validateRegister = (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = validateRegisterBody(req.body);
      next();
    } catch (err) {
      next(err);
    }
  };

  // Login Validation Middleware
  const validateLogin = (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = validateLoginBody(req.body);
      next();
    } catch (err) {
      next(err);
    }
  };

  // Public Identity Endpoints (Rate-Limited Against Brute-Force & Flooding)
  router.post('/register', limiter, validateRegister, authController.register);
  router.all('/register', methodNotAllowed(['POST']));

  router.post('/login', limiter, validateLogin, authController.login);
  router.all('/login', methodNotAllowed(['POST']));

  // Protected Authenticated Identity Endpoint
  router.get('/me', authenticate, authController.getMe);
  router.all('/me', methodNotAllowed(['GET']));

  return router;
}
