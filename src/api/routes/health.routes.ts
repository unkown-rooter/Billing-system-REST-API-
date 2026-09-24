import { Router } from 'express';
import { HealthController } from '../controllers/health.controller.js';

export function createHealthRouter(healthController?: HealthController): Router {
  const router = Router();
  const controller = healthController || new HealthController();

  router.get('/health', controller.getHealth);

  return router;
}
