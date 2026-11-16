import { compressionRequestSchema, jobIdParamsSchema } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError, parseInput } from '../http/validation.ts';
import { CompressionError } from '../modules/compression/compression-service.ts';
import type { CompressionService } from '../modules/compression/compression-service.ts';
import type { NoticeBatchService } from '../modules/notifications/notice-batches.ts';
import { requesterOf } from './history.ts';
import { rethrowJobRejection } from './jobs.ts';
import { assertNoticeBatch } from './mail.ts';

export type CompressionRoutesOptions = {
  compression: CompressionService;
  noticeBatches: NoticeBatchService;
};

const toHttpError = (error: unknown): unknown =>
  error instanceof CompressionError
    ? new HttpError(error.status, error.code, error.message)
    : error;

/** Compresión de video (D-108). La subida es la misma de Convertir (`/api/uploads`). */
export function registerCompressionRoutes(
  app: FastifyInstance,
  options: CompressionRoutesOptions,
): void {
  app.get('/api/compression/sources/:id', async (request) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    try {
      return await options.compression.getSource(id);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post('/api/jobs/compress', async (request, reply) => {
    const body = parseInput(compressionRequestSchema, request.body ?? {});
    const requester = requesterOf(request);
    if (requester.userId !== null) {
      assertNoticeBatch(options.noticeBatches, body.batchId, requester.userId);
    }
    try {
      const job = await options.compression.enqueue(body, requester);
      return await reply.status(202).send({ jobId: job.id });
    } catch (error) {
      rethrowJobRejection(error);
      throw toHttpError(error);
    }
  });
}
