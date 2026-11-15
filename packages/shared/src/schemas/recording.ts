import { z } from 'zod';
import { notifyUserIdsSchema } from './users.ts';

/**
 * Formatos de captura, en orden de preferencia (SPEC §6). La web elige el
 * primero que el navegador soporte (`MediaRecorder.isTypeSupported`). El
 * server igual normaliza siempre a MP4 H.264 + AAC.
 */
export const RECORDING_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm',
] as const;

/** Contenedor del archivo crudo según el MIME que informa MediaRecorder. null = no aceptado. */
export function recordingContainer(mimeType: string): 'mp4' | 'webm' | null {
  const base = mimeType.split(';')[0]?.trim().toLowerCase();
  if (base === 'video/mp4') return 'mp4';
  if (base === 'video/webm') return 'webm';
  return null;
}

export const RECORDING_FPS = [30, 60] as const;

/** Cada cuánto MediaRecorder entrega un fragmento (`timeslice`). */
export const RECORDING_CHUNK_INTERVAL_MS = 2000;

export const createRecordingRequestSchema = z.object({
  mimeType: z
    .string()
    .trim()
    .max(100)
    .refine((value) => recordingContainer(value) !== null, {
      error: 'Formato de grabación no soportado.',
    }),
  fps: z.union([z.literal(30), z.literal(60)]),
  title: z.string().trim().min(1).max(200),
  /** A quién avisar por mail cuando termine de procesarse o falle (D-104). */
  notify: notifyUserIdsSchema,
  /**
   * Programada (inicio a una hora o corte automático): avisa también al
   * empezar (D-109).
   */
  programmed: z.boolean().default(false),
  /** Corte previsto, para el aviso de inicio. */
  stopAt: z.iso.datetime({ error: 'Hora de corte inválida.' }).nullable().default(null),
  /** La programación registrada que se cumple al empezar (D-109). */
  scheduleId: z.uuid({ error: 'Programación inválida.' }).nullable().default(null),
});
export type CreateRecordingRequest = z.input<typeof createRecordingRequestSchema>;

/**
 * Grabación con inicio a una hora (D-109): se registra en el server al
 * programarla, para avisar si a la hora no empezó.
 */
export const createRecordingScheduleRequestSchema = z.object({
  startAt: z.iso.datetime({ error: 'Hora de inicio inválida.' }),
  stopAt: z.iso.datetime({ error: 'Hora de corte inválida.' }).nullable().default(null),
  title: z.string().trim().min(1).max(200),
  notify: notifyUserIdsSchema,
});
export type CreateRecordingScheduleRequest = z.input<typeof createRecordingScheduleRequestSchema>;

export const createRecordingScheduleResponseSchema = z.object({ scheduleId: z.uuid() });

export const recordingScheduleParamsSchema = z.object({
  id: z.uuid({ error: 'Programación inválida.' }),
});

/** La pestaña vio que no se pudo empezar (se dejó de compartir, el navegador falló…). */
export const failRecordingScheduleRequestSchema = z.object({
  reason: z.string().trim().min(1).max(300),
});

export const createRecordingResponseSchema = z.object({
  recordingId: z.uuid(),
  /** Tamaño máximo de un fragmento. */
  maxChunkBytes: z.number().int().positive(),
});

export const recordingIdParamsSchema = z.object({
  id: z.uuid({ error: 'Id de grabación inválido.' }),
});

export const chunkQuerySchema = z.object({
  /** Número de fragmento, empezando en 0. */
  seq: z.coerce.number().int().min(0).max(1_000_000),
});

/** Después de cada fragmento: cuál espera el server ahora (sirve para reintentar). */
export const chunkResponseSchema = z.object({ nextSeq: z.number().int().nonnegative() });

export const finishRecordingResponseSchema = z.object({ jobId: z.uuid() });
