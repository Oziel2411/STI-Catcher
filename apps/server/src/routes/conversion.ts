import type { Readable } from 'node:stream';
import { conversionRequestSchema, jobIdParamsSchema } from '@sti-catcher/shared';
import type { ConversionOptionsResponse } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError, parseInput } from '../http/validation.ts';
import { ConversionError } from '../modules/conversion/conversion-service.ts';
import type { ConversionService } from '../modules/conversion/conversion-service.ts';
import { UploadError } from '../modules/conversion/upload-service.ts';
import type { UploadService } from '../modules/conversion/upload-service.ts';
import { requesterOf } from './history.ts';
import { rethrowJobRejection } from './jobs.ts';

export type ConversionRoutesOptions = {
  conversion: ConversionService;
  upload: UploadService;
  options: ConversionOptionsResponse;
};

const toHttpError = (error: unknown): unknown =>
  error instanceof ConversionError || error instanceof UploadError
    ? new HttpError(error.status, error.code, error.message)
    : error;

/** Nombre original del archivo, mandado por el navegador en un header (URL-encoded). */
function readFileNameHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function registerConversionRoutes(
  app: FastifyInstance,
  options: ConversionRoutesOptions,
): void {
  app.get('/api/conversion/options', () => options.options);

  app.get('/api/conversion/sources/:id', async (request) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    try {
      return await options.conversion.getSource(id);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  // Subida: cuerpo = el archivo (application/octet-stream); nombre en `x-file-name`.
  app.post('/api/uploads', async (request, reply) => {
    if (request.headers['content-type'] !== 'application/octet-stream') {
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'El archivo tiene que enviarse como application/octet-stream.',
      );
    }
    const length = Number(request.headers['content-length']);
    try {
      const job = await options.upload({
        stream: request.body as Readable,
        declaredBytes: Number.isFinite(length) && length >= 0 ? length : null,
        fileName: readFileNameHeader(request.headers['x-file-name']),
        requester: requesterOf(request),
      });
      return await reply.status(201).send({ jobId: job.id });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post('/api/jobs/convert', async (request, reply) => {
    const body = parseInput(conversionRequestSchema, request.body ?? {});
    try {
      const job = await options.conversion.enqueue(body, requesterOf(request));
      return await reply.status(202).send({ jobId: job.id });
    } catch (error) {
      rethrowJobRejection(error);
      throw toHttpError(error);
    }
  });
}
