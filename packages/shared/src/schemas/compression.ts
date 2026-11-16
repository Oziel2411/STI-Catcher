import { z } from 'zod';
import { compressionOptionsSchema, resolvedEncodersSchema } from '../presets/compression.ts';
import { sourceMediaSchema } from './conversion.ts';
import { jobSchema } from './jobs.ts';
import { noticeBatchIdSchema } from './mail.ts';
import { notifyUserIdsSchema } from './users.ts';

/** Lo que hace falta del original para estimar en la web (D-108). */
export const compressionSourceMediaSchema = sourceMediaSchema.extend({
  frameRate: z.number().positive().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});
export type CompressionSourceMedia = z.infer<typeof compressionSourceMediaSchema>;

export const compressionSourceResponseSchema = z.object({
  job: jobSchema,
  media: compressionSourceMediaSchema,
  /** Con qué codifica el server cada códec: decide el margen del tamaño objetivo. */
  encoders: resolvedEncodersSchema,
});
export type CompressionSourceResponse = z.infer<typeof compressionSourceResponseSchema>;

export const compressionRequestSchema = compressionOptionsSchema.extend({
  sourceJobId: z.uuid({ error: 'Id de archivo de origen inválido.' }),
  /** A quién avisar por mail al terminar o fallar (D-104). */
  notify: notifyUserIdsSchema,
  /** Pedido de varios archivos con un solo aviso (D-105). */
  batchId: noticeBatchIdSchema,
});
export type CompressionRequest = z.input<typeof compressionRequestSchema>;
