import { z } from 'zod';
import { sourceMediaSchema } from './conversion.ts';
import { jobSchema } from './jobs.ts';
import { noticeBatchIdSchema } from './mail.ts';
import { notifyUserIdsSchema } from './users.ts';

/**
 * Recortar y dividir (D-114). La persona marca cortes sobre el video; cada
 * tramo que queda se manda como `{ start, end }` en segundos del original.
 */

/** Un tramo más corto no sirve para nada y suele ser un clic de más. */
export const EDIT_MIN_SEGMENT_SECONDS = 0.5;
/** Tope de tramos por pedido: al dividir, cada uno es un trabajo. */
export const EDIT_MAX_SEGMENTS = 20;

/**
 * - `exact`: recodifica y corta en el cuadro pedido (por defecto).
 * - `fast`: copia sin recodificar; el corte se mueve al cuadro clave anterior.
 */
export const EDIT_PRECISIONS = ['exact', 'fast'] as const;
export const editPrecisionSchema = z.enum(EDIT_PRECISIONS);
export type EditPrecision = z.infer<typeof editPrecisionSchema>;

/** `single`: un archivo con los tramos unidos. `split`: un archivo (y un trabajo) por tramo. */
export const EDIT_OUTPUTS = ['single', 'split'] as const;
export const editOutputSchema = z.enum(EDIT_OUTPUTS);
export type EditOutput = z.infer<typeof editOutputSchema>;

export const editSegmentSchema = z
  .object({
    start: z.number().min(0),
    end: z.number().positive(),
  })
  .refine((segment) => segment.end - segment.start >= EDIT_MIN_SEGMENT_SECONDS - 1e-6, {
    error: 'Cada tramo tiene que durar al menos medio segundo.',
    path: ['end'],
  });
export type EditSegment = z.infer<typeof editSegmentSchema>;

export const editSegmentsSchema = z
  .array(editSegmentSchema)
  .min(1, 'Elegí al menos un tramo.')
  .max(EDIT_MAX_SEGMENTS, `Se pueden elegir hasta ${String(EDIT_MAX_SEGMENTS)} tramos.`)
  .refine(
    (segments) => segments.every((segment, i) => segment.start >= (segments[i - 1]?.end ?? 0)),
    { error: 'Los tramos tienen que estar en orden y sin pisarse.' },
  );

export const editOptionsSchema = z.object({
  segments: editSegmentsSchema,
  output: editOutputSchema.default('single'),
  precision: editPrecisionSchema.default('exact'),
});
export type EditOptions = z.infer<typeof editOptionsSchema>;

export const editRequestSchema = editOptionsSchema.extend({
  sourceJobId: z.uuid({ error: 'Id de archivo de origen inválido.' }),
  /** A quién avisar por mail al terminar o fallar (D-104). */
  notify: notifyUserIdsSchema,
  /** Pedido con un solo aviso (D-105). Al dividir sin uno, el server abre el suyo. */
  batchId: noticeBatchIdSchema,
});
export type EditRequest = z.input<typeof editRequestSchema>;

export const editSourceResponseSchema = z.object({
  job: jobSchema,
  media: sourceMediaSchema.extend({
    /** Para ir cuadro por cuadro; null si ffprobe no lo sabe. */
    frameRate: z.number().positive().nullable(),
  }),
});
export type EditSourceResponse = z.infer<typeof editSourceResponseSchema>;

/** Un id por archivo que se va a generar, en el orden de los tramos. */
export const editResponseSchema = z.object({ jobIds: z.array(z.uuid()).min(1) });
export type EditResponse = z.infer<typeof editResponseSchema>;
