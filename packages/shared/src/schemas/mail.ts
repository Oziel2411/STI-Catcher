import { z } from 'zod';
import { notifyUserIdsSchema } from './users.ts';

/**
 * Avisos por mail (D-099, D-104). Los mails van a las cuentas que cada uno
 * elige al pedir un trabajo; acá solo se dice si hay servidor de correo.
 */
export const mailStatusResponseSchema = z.object({
  /** Hay servidor SMTP configurado. */
  configured: z.boolean(),
  /** Remitente (la casilla que manda). null sin SMTP. */
  from: z.string().nullable(),
});
export type MailStatusResponse = z.infer<typeof mailStatusResponseSchema>;

/** El mail de prueba va a quien lo pide. */
export const mailTestResponseSchema = z.object({ sentTo: z.string() });

/**
 * Aviso agrupado (D-105): antes de crear varios trabajos de una vez (una lista
 * de links o de archivos), la web abre un pedido; cada trabajo lleva su
 * `batchId` y, al terminar todos, sale un solo mail con la lista.
 */
export const createNoticeBatchRequestSchema = z.object({
  notify: notifyUserIdsSchema,
});
export type CreateNoticeBatchRequest = z.input<typeof createNoticeBatchRequestSchema>;

export const createNoticeBatchResponseSchema = z.object({ batchId: z.uuid() });

/** Id de un pedido con aviso agrupado; null = el trabajo avisa solo, como siempre. */
export const noticeBatchIdSchema = z.uuid({ error: 'Pedido inválido.' }).nullable().default(null);
