import { z } from 'zod';

/** Familia de codec de video, para avisar compatibilidad en la UI. */
export const VIDEO_CODEC_FAMILIES = ['h264', 'h265', 'vp9', 'av1', 'other'] as const;
export const videoCodecFamilySchema = z.enum(VIDEO_CODEC_FAMILIES);
export type VideoCodecFamily = z.infer<typeof videoCodecFamilySchema>;

/** URL http/https (SPEC §5). El resto de los esquemas (file:, ftp:, javascript:) se rechaza. */
export const httpUrlSchema = z
  .string({ error: 'Pegá un link.' })
  .trim()
  .min(1, { error: 'Pegá un link.' })
  .max(2048, { error: 'El link es demasiado largo.' })
  .pipe(
    z.url({
      protocol: /^https?$/,
      error: 'Tiene que ser un link que empiece con http:// o https://.',
    }),
  );

export const probeRequestSchema = z.object({ url: httpUrlSchema });

export const resolutionOptionSchema = z.object({
  height: z.number().int().positive(),
  /** Codecs en los que el sitio ofrece esa resolución, sin repetir. */
  codecs: z.array(videoCodecFamilySchema).min(1),
});
export type ResolutionOption = z.infer<typeof resolutionOptionSchema>;

export const probeResponseSchema = z.object({
  /** URL canónica según el sitio (puede diferir de la pegada). */
  url: z.string(),
  title: z.string(),
  /** Nombre del sitio según yt-dlp, p. ej. "Youtube". */
  site: z.string(),
  uploader: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  isLive: z.boolean(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  /** De mayor a menor. Vacío si el sitio no informa resoluciones. */
  resolutions: z.array(resolutionOptionSchema),
  /** Mayor altura disponible en H.264. null si no hay H.264. */
  maxH264Height: z.number().int().positive().nullable(),
});
export type ProbeResponse = z.infer<typeof probeResponseSchema>;

export const DOWNLOAD_FORMATS = ['mp4', 'mp3', 'm4a'] as const;
export const downloadFormatSchema = z.enum(DOWNLOAD_FORMATS);
export type DownloadFormat = z.infer<typeof downloadFormatSchema>;

/**
 * Cómo se arma el MP4 (SPEC §5):
 * - compat: la mejor resolución en H.264 que no supere la elegida (default).
 * - quality: codec original (VP9/AV1) dentro de MP4. Rápido, menos compatible.
 * - recode: la resolución elegida, recodificada a H.264. Lento, usa mucha CPU.
 */
export const VIDEO_MODES = ['compat', 'quality', 'recode'] as const;
export const videoModeSchema = z.enum(VIDEO_MODES);
export type VideoMode = z.infer<typeof videoModeSchema>;

export const downloadRequestSchema = z.object({
  url: httpUrlSchema,
  format: downloadFormatSchema.default('mp4'),
  /** Altura máxima en píxeles; null = la mejor disponible. Se ignora para audio. */
  maxHeight: z.number().int().min(100).max(4320).nullable().default(null),
  videoMode: videoModeSchema.default('compat'),
  /**
   * Título del análisis previo, para mostrar mientras se descarga. Al
   * terminar se reemplaza por el que informa yt-dlp.
   */
  title: z.string().trim().max(500).nullable().default(null),
});
export type DownloadRequest = z.input<typeof downloadRequestSchema>;
