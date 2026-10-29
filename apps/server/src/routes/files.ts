import { jobIdParamsSchema } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError, parseInput } from '../http/validation.ts';
import type { JobFiles } from '../modules/files/job-files.ts';

/**
 * Archivo de un job (SPEC §8): se pide por jobId, nunca por una ruta.
 * `reply.download` (@fastify/static) responde con `Content-Disposition` según
 * RFC 5987 (tildes, ñ y emojis llegan bien) y soporta HTTP Range.
 */
export function registerFileRoutes(app: FastifyInstance, jobFiles: JobFiles): void {
  app.get('/api/jobs/:id/file', async (request, reply) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    const result = await jobFiles(id);
    switch (result.kind) {
      case 'not_found':
        throw new HttpError(404, 'JOB_NOT_FOUND', 'No existe ese trabajo.');
      case 'not_ready':
        throw new HttpError(
          409,
          'FILE_NOT_READY',
          'El trabajo todavía no terminó o no generó un archivo.',
        );
      case 'gone':
        // 410 Gone: existió, pero ya no está (retención o borrado manual).
        throw new HttpError(410, 'FILE_GONE', 'El archivo ya no está disponible en el servidor.');
      case 'ok':
        // La raíz es STORAGE_DIR/files: es la de la instancia de @fastify/static registrada en app.ts.
        return reply.download(result.fileName, result.downloadName);
    }
  });
}
