import { downloadRequestSchema, probeRequestSchema } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError, parseInput } from '../http/validation.ts';
import { MediaRequestError } from '../modules/download/download-service.ts';
import type { DownloadService } from '../modules/download/download-service.ts';
import { rethrowJobRejection } from './jobs.ts';

const toHttpError = (error: unknown): unknown =>
  error instanceof MediaRequestError
    ? new HttpError(error.status, error.code, error.message)
    : error;

export function registerMediaRoutes(app: FastifyInstance, download: DownloadService): void {
  // Análisis previo: responde en segundos, no es un job.
  app.post('/api/media/probe', async (request) => {
    const { url } = parseInput(probeRequestSchema, request.body ?? {});
    try {
      return await download.probe(url);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post('/api/jobs/download', async (request, reply) => {
    const body = parseInput(downloadRequestSchema, request.body ?? {});
    try {
      const job = await download.enqueue(body, { clientId: request.clientId, ip: request.ip });
      return await reply.status(202).send({ jobId: job.id });
    } catch (error) {
      rethrowJobRejection(error);
      throw toHttpError(error);
    }
  });
}
