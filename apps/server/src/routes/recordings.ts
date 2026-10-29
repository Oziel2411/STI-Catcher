import type { Readable } from 'node:stream';
import {
  chunkQuerySchema,
  createRecordingRequestSchema,
  recordingIdParamsSchema,
} from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError, parseInput } from '../http/validation.ts';
import { RecordingError } from '../modules/recording/recording-service.ts';
import type { RecordingService } from '../modules/recording/recording-service.ts';
import { requesterOf } from './history.ts';
import { rethrowJobRejection } from './jobs.ts';

const toHttpError = (error: unknown): unknown =>
  error instanceof RecordingError ? new HttpError(error.status, error.code, error.message) : error;

/**
 * Grabación de pantalla (SPEC §6):
 * 1. POST /api/recordings → crea la sesión.
 * 2. POST /api/recordings/:id/chunks?seq=N (binario) → un fragmento, en orden.
 * 3. POST /api/recordings/:id/finish → crea el job que normaliza a MP4.
 */
export function registerRecordingRoutes(app: FastifyInstance, recordings: RecordingService): void {
  app.post('/api/recordings', async (request, reply) => {
    const body = parseInput(createRecordingRequestSchema, request.body ?? {});
    try {
      return await reply.status(201).send(await recordings.create(body, requesterOf(request)));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post('/api/recordings/:id/chunks', async (request) => {
    const { id } = parseInput(recordingIdParamsSchema, request.params);
    const { seq } = parseInput(chunkQuerySchema, request.query);
    if (request.headers['content-type'] !== 'application/octet-stream') {
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'El fragmento tiene que enviarse como application/octet-stream.',
      );
    }
    const length = Number(request.headers['content-length']);
    try {
      return await recordings.appendChunk(
        id,
        seq,
        request.body as Readable,
        Number.isFinite(length) && length >= 0 ? length : null,
        requesterOf(request),
      );
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post('/api/recordings/:id/finish', async (request, reply) => {
    const { id } = parseInput(recordingIdParamsSchema, request.params);
    try {
      const job = await recordings.finish(id, requesterOf(request));
      return await reply.status(202).send({ jobId: 'jobId' in job ? job.jobId : job.id });
    } catch (error) {
      rethrowJobRejection(error);
      throw toHttpError(error);
    }
  });
}
