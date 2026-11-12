import { createNoticeBatchRequestSchema } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MailError } from '../adapters/mailer.ts';
import { HttpError, parseInput } from '../http/validation.ts';
import { requireUser } from '../http/session.ts';
import { MailServiceError } from '../modules/notifications/mail-service.ts';
import type { MailService } from '../modules/notifications/mail-service.ts';
import { NoticeBatchError } from '../modules/notifications/notice-batches.ts';
import type { NoticeBatchService } from '../modules/notifications/notice-batches.ts';

const batchParamsSchema = z.object({ id: z.uuid({ error: 'Pedido inválido.' }) });

/** NoticeBatchError → error HTTP; lo demás sigue igual. */
export const noticeBatchHttpError = (error: unknown): unknown =>
  error instanceof NoticeBatchError
    ? new HttpError(error.status, error.code, error.message)
    : error;

/** Para Descargar y Convertir: un `batchId` tiene que ser un pedido abierto de quien pide. */
export function assertNoticeBatch(
  batches: NoticeBatchService,
  batchId: string | null,
  userId: string,
): void {
  if (batchId === null) return;
  try {
    batches.assertOpen(batchId, userId);
  } catch (error) {
    throw noticeBatchHttpError(error);
  }
}

export function registerMailRoutes(
  app: FastifyInstance,
  mail: MailService,
  batches: NoticeBatchService,
  logger: { warn: (obj: object, msg: string) => void },
): void {
  app.get('/api/mail', () => mail.status());

  // Manda un mail de prueba a la cuenta que lo pide (página Estado).
  app.post('/api/mail/test', async (request) => {
    try {
      const user = requireUser(request);
      return await mail.sendTest({ email: user.email, name: user.name });
    } catch (error) {
      if (error instanceof MailServiceError) {
        throw new HttpError(error.status, error.code, error.message);
      }
      if (error instanceof MailError) {
        logger.warn({ code: error.code, err: error.cause }, 'Falló el mail de prueba');
        throw new HttpError(502, `MAIL_${error.code}`, error.message);
      }
      throw error;
    }
  });

  // Aviso agrupado (D-105): abrir un pedido antes de crear varios trabajos…
  app.post('/api/notice-batches', async (request, reply) => {
    const { notify } = parseInput(createNoticeBatchRequestSchema, request.body ?? {});
    const batchId = batches.create(requireUser(request).id, notify);
    return reply.status(201).send({ batchId });
  });

  // …y cerrarlo cuando ya se crearon todos (los que se pudieron).
  app.post('/api/notice-batches/:id/close', async (request, reply) => {
    const { id } = parseInput(batchParamsSchema, request.params);
    try {
      batches.close(id, requireUser(request).id);
    } catch (error) {
      throw noticeBatchHttpError(error);
    }
    return reply.status(204).send();
  });
}
