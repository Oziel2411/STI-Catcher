import { historyQuerySchema, jobIdParamsSchema } from '@sti-catcher/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError, parseInput } from '../http/validation.ts';
import { requireUser } from '../http/session.ts';
import { HistoryError } from '../modules/history/history-service.ts';
import type { HistoryService, Requester } from '../modules/history/history-service.ts';
import { rethrowJobRejection } from './jobs.ts';

export const requesterOf = (request: FastifyRequest): Requester => ({
  userId: requireUser(request).id,
  ip: request.ip,
});

const toHttpError = (error: unknown): unknown =>
  error instanceof HistoryError ? new HttpError(error.status, error.code, error.message) : error;

export function registerHistoryRoutes(app: FastifyInstance, history: HistoryService): void {
  app.get('/api/history', async (request) => {
    const query = parseInput(historyQuerySchema, request.query);
    return history.list(query, requesterOf(request));
  });

  app.get('/api/history/requesters', () => history.requesters());

  app.get('/api/active-jobs', (request) => history.activeCounts(requesterOf(request)));

  // Solo los trabajos propios (mismo navegador). Borra el registro y el archivo.
  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    try {
      await history.remove(id, requesterOf(request));
    } catch (error) {
      throw toHttpError(error);
    }
    return reply.status(204).send();
  });

  // Crea un trabajo nuevo con los mismos parámetros; el original no cambia.
  app.post('/api/jobs/:id/retry', async (request, reply) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    try {
      const job = await history.retry(id, requesterOf(request));
      return await reply.status(202).send({ jobId: job.id });
    } catch (error) {
      rethrowJobRejection(error);
      throw toHttpError(error);
    }
  });
}
