import {
  historyBulkDeleteBodySchema,
  historyQuerySchema,
  jobIdParamsSchema,
  renameJobBodySchema,
  trashIdsBodySchema,
} from '@sti-catcher/shared';
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

  // Solo los trabajos propios (D-104). El trabajo y su archivo van a la papelera (D-115).
  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    try {
      await history.remove(id, requesterOf(request));
    } catch (error) {
      throw toHttpError(error);
    }
    return reply.status(204).send();
  });

  // Solo el archivo, a la papelera: el trabajo queda como expirado (D-113, D-115).
  app.delete('/api/jobs/:id/file', async (request) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    try {
      return { job: await history.removeFile(id, requesterOf(request)) };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  // Varios a la vez (selección múltiple del historial, D-113).
  app.post('/api/history/delete', async (request) => {
    const { ids, what } = parseInput(historyBulkDeleteBodySchema, request.body);
    return history.removeMany(ids, what, requesterOf(request));
  });

  // Papelera (D-115): solo la propia.
  app.get('/api/trash', (request) => history.trash(requesterOf(request)));

  app.post('/api/trash/restore', async (request) => {
    const { ids } = parseInput(trashIdsBodySchema, request.body);
    return history.restoreMany(ids, requesterOf(request));
  });

  app.post('/api/trash/purge', async (request) => {
    const { ids } = parseInput(trashIdsBodySchema, request.body);
    return history.purgeMany(ids, requesterOf(request));
  });

  app.post('/api/trash/empty', async (request) => history.emptyTrash(requesterOf(request)));

  app.patch('/api/jobs/:id', (request) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    const { title } = parseInput(renameJobBodySchema, request.body);
    try {
      return { job: history.rename(id, title, requesterOf(request)) };
    } catch (error) {
      throw toHttpError(error);
    }
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
