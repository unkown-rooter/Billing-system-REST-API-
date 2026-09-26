import { Router } from 'express';
import { HealthController } from '../controllers/health.controller.js';
import { methodNotAllowed } from '../middlewares/method-not-allowed.middleware.js';

export function createHealthRouter(healthController?: HealthController): Router {
  const router = Router();
  const controller = healthController || new HealthController();

  router.get('/health', controller.getHealth);
  router.all('/health', methodNotAllowed(['GET']));

  return router;
}
