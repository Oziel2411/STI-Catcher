import { healthQuerySchema } from '@sti-catcher/shared';
import type { HealthResponse } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { parseInput } from '../http/validation.ts';
import type { HealthService } from '../modules/health/health-service.ts';

export function registerHealthRoutes(app: FastifyInstance, health: HealthService): void {
  app.get('/api/health', async (request): Promise<HealthResponse> => {
    const { refresh } = parseInput(healthQuerySchema, request.query);
    return health.getHealth({ refresh });
  });
}
