import {
  createSelftestRequestSchema,
  jobIdParamsSchema,
  listJobsQuerySchema,
} from '@sti-catcher/shared';
import type { Job } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError, parseInput } from '../http/validation.ts';
import { JobRejectedError } from '../jobs/errors.ts';
import type { EnqueueInput, JobQueue } from '../jobs/queue.ts';
import { selftestTitle } from '../modules/selftest/selftest-runner.ts';

/** Si la cola rechazó el job, lo traduce a un error HTTP. Cualquier otro error sigue de largo. */
export function rethrowJobRejection(error: unknown): void {
  if (error instanceof JobRejectedError) {
    // 507 Insufficient Storage: el código HTTP pensado exactamente para este caso.
    const status = error.code === 'INSUFFICIENT_DISK' ? 507 : 501;
    throw new HttpError(status, error.code, error.message);
  }
}

/** Crea el job y traduce los rechazos de la cola a errores HTTP. */
export async function enqueueOrThrow(queue: JobQueue, input: EnqueueInput): Promise<Job> {
  try {
    return await queue.enqueue(input);
  } catch (error) {
    rethrowJobRejection(error);
    throw error;
  }
}

export function registerJobRoutes(app: FastifyInstance, queue: JobQueue): void {
  // Handlers sincrónicos: la base (better-sqlite3) es sincrónica; los errores
  // que lanzan llegan igual al error handler de app.ts.
  app.get('/api/jobs', (request, reply) => {
    const query = parseInput(listJobsQuerySchema, request.query);
    return reply.send({
      jobs: queue.list({
        ...(query.status ? { statuses: query.status } : {}),
        ...(query.type ? { types: query.type } : {}),
        limit: query.limit,
      }),
    });
  });

  app.get('/api/jobs/:id', (request, reply) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    const job = queue.get(id);
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'No existe ese trabajo.');
    return reply.send({ job });
  });

  // Crear devuelve 202 + jobId de inmediato; el trabajo sigue en segundo plano (SPEC §4).
  app.post('/api/jobs/selftest', async (request, reply) => {
    const { durationSeconds } = parseInput(createSelftestRequestSchema, request.body ?? {});
    const job = await enqueueOrThrow(queue, {
      type: 'selftest',
      params: { durationSeconds },
      title: selftestTitle(durationSeconds),
      clientIp: request.ip,
      clientId: request.clientId,
    });
    return reply.status(202).send({ jobId: job.id });
  });

  // POST y no DELETE: DELETE /api/jobs/:id queda para borrar del historial (Fase 4).
  app.post('/api/jobs/:id/cancel', async (request, reply) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    const result = queue.cancel(id);
    switch (result.outcome) {
      case 'not_found':
        throw new HttpError(404, 'JOB_NOT_FOUND', 'No existe ese trabajo.');
      case 'not_active':
        throw new HttpError(409, 'JOB_NOT_ACTIVE', 'El trabajo ya terminó: no se puede cancelar.');
      case 'cancelled':
        return reply.status(200).send({ job: result.job });
      case 'cancelling':
        // Se está deteniendo: el estado final llega por SSE.
        return reply.status(202).send({ job: result.job });
    }
  });
}
