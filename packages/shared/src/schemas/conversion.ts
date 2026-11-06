import { z } from 'zod';
import { conversionPresetIdSchema } from '../presets/conversion.ts';
import { jobSchema } from './jobs.ts';
import { notifyUserIdsSchema } from './users.ts';

/** Lo que tiene el archivo de origen (de ffprobe). */
export const sourceMediaSchema = z.object({
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  durationSeconds: z.number().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
});
export type SourceMedia = z.infer<typeof sourceMediaSchema>;

export const conversionSourceResponseSchema = z.object({
  job: jobSchema,
  media: sourceMediaSchema,
  /** Presets válidos para este archivo (SPEC §7: solo lo que tiene sentido). */
  presets: z.array(conversionPresetIdSchema),
});
export type ConversionSourceResponse = z.infer<typeof conversionSourceResponseSchema>;

/** Límites del GIF (D-043). Los define el `.env` del server. */
export const gifLimitsSchema = z.object({
  maxSeconds: z.number().positive(),
  maxFps: z.number().int().positive(),
  maxWidth: z.number().int().positive(),
  defaultFps: z.number().int().positive(),
  defaultWidth: z.number().int().positive(),
});
export type GifLimits = z.infer<typeof gifLimitsSchema>;

export const conversionOptionsResponseSchema = z.object({
  gif: gifLimitsSchema,
  maxUploadBytes: z.number().int().positive(),
});
export type ConversionOptionsResponse = z.infer<typeof conversionOptionsResponseSchema>;

export const gifOptionsSchema = z
  .object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    fps: z.number().int().min(1).max(50),
    width: z.number().int().min(32).max(3840),
  })
  .refine((gif) => gif.endSeconds > gif.startSeconds, {
    error: 'El fin tiene que ser posterior al inicio.',
    path: ['endSeconds'],
  });
export type GifOptions = z.infer<typeof gifOptionsSchema>;

export const conversionRequestSchema = z.object({
  sourceJobId: z.uuid({ error: 'Id de archivo de origen inválido.' }),
  preset: conversionPresetIdSchema,
  /** Escalar hacia abajo a esta altura (solo presets de video). null = mantener. */
  maxHeight: z.number().int().min(100).max(4320).nullable().default(null),
  /** Obligatorio para el preset GIF. */
  gif: gifOptionsSchema.optional(),
  /** A quién avisar por mail al terminar o fallar (D-104). */
  notify: notifyUserIdsSchema,
});
export type ConversionRequest = z.input<typeof conversionRequestSchema>;

export const uploadResponseSchema = z.object({ jobId: z.uuid() });
