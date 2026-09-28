import { Router } from 'express';
import { HealthController } from '../controllers/health.controller.js';
import { methodNotAllowed } from '../middlewares/method-not-allowed.middleware.js';

export function createHealthRouter(healthController?: HealthController): Router {
  const router = Router();
  const controller = healthController || new HealthController();

  router.get('/health', controller.getHealth);
  router.all('/health', methodNotAllowed(['GET']));

  router.get('/health/live', controller.getLiveness);
  router.all('/health/live', methodNotAllowed(['GET']));

  router.get('/health/ready', controller.getReadiness);
  router.all('/health/ready', methodNotAllowed(['GET']));

  router.get('/metrics', controller.getMetrics);
  router.all('/metrics', methodNotAllowed(['GET']));

  return router;
}
