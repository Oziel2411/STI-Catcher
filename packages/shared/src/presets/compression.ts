import { z } from 'zod';

/**
 * Presets de compresión (D-108): lista cerrada, al estilo de HandBrake. Cada
 * preset describe la intención (códec, calidad, tope de resolución y fps,
 * audio); qué encoder lo hace (CPU o GPU) lo decide el server al arrancar,
 * según lo que la máquina pueda codificar de verdad.
 *
 * La salida es siempre MP4 (H.264 o H.265 + AAC).
 */
export const COMPRESSION_PRESET_IDS = [
  'fast-1080p',
  'fast-720p',
  'share-720p',
  'screen',
  'archive-1080p',
  'archive-original',
] as const;
export const compressionPresetIdSchema = z.enum(COMPRESSION_PRESET_IDS);
export type CompressionPresetId = z.infer<typeof compressionPresetIdSchema>;

export type CompressionCodec = 'h264' | 'hevc';

/** Velocidad del encoder: más lento comprime mejor al mismo tamaño. */
export type CompressionSpeed = 'fast' | 'balanced';

export type CompressionPreset = {
  id: CompressionPresetId;
  label: string;
  /** Para qué sirve, en palabras del usuario. */
  description: string;
  codec: CompressionCodec;
  /**
   * Calidad constante en la escala RF/CRF de HandBrake y x264 (0 = sin
   * pérdida, 51 = lo peor; +6 ≈ la mitad de tamaño). En H.265 el mismo número
   * da un archivo más chico a calidad parecida.
   */
  quality: number;
  speed: CompressionSpeed;
  /** Tope de altura; null = la del original. Solo se baja, nunca se sube. */
  maxHeight: number | null;
  /** Tope de cuadros por segundo; null = los del original. */
  maxFps: number | null;
  audioKbps: AudioKbps;
};

export const AUDIO_KBPS = [64, 96, 128, 160] as const;
export type AudioKbps = (typeof AUDIO_KBPS)[number];
export const audioKbpsSchema = z.union(AUDIO_KBPS.map((kbps) => z.literal(kbps)));

export const COMPRESSION_PRESETS: Record<CompressionPresetId, CompressionPreset> = {
  'fast-1080p': {
    id: 'fast-1080p',
    label: 'Rápido 1080p30',
    description: 'Buena calidad en Full HD, a 30 cuadros. Para uso general.',
    codec: 'h264',
    quality: 22,
    speed: 'fast',
    maxHeight: 1080,
    maxFps: 30,
    audioKbps: 160,
  },
  'fast-720p': {
    id: 'fast-720p',
    label: 'Rápido 720p30',
    description: 'HD a 30 cuadros: bastante más liviano y se ve bien en cualquier pantalla.',
    codec: 'h264',
    quality: 22,
    speed: 'fast',
    maxHeight: 720,
    maxFps: 30,
    audioKbps: 128,
  },
  'share-720p': {
    id: 'share-720p',
    label: 'Para compartir 720p',
    description: 'Lo más liviano que todavía se ve bien: para mail, WhatsApp o una plataforma.',
    codec: 'h264',
    quality: 26,
    speed: 'balanced',
    maxHeight: 720,
    maxFps: 30,
    audioKbps: 96,
  },
  screen: {
    id: 'screen',
    label: 'Grabación de pantalla',
    description: 'Mantiene la resolución para que el texto se lea; baja los cuadros y el audio.',
    codec: 'h264',
    quality: 24,
    speed: 'balanced',
    maxHeight: null,
    maxFps: 30,
    audioKbps: 96,
  },
  'archive-1080p': {
    id: 'archive-1080p',
    label: 'Archivar 1080p (H.265)',
    description:
      'Ocupa poco disco con buena calidad. Algunas PCs no lo abren sin una extensión de Windows.',
    codec: 'hevc',
    quality: 24,
    speed: 'balanced',
    maxHeight: 1080,
    maxFps: null,
    audioKbps: 128,
  },
  'archive-original': {
    id: 'archive-original',
    label: 'Archivar original (H.265)',
    description:
      'Como el original, en mucho menos espacio. Algunas PCs no lo abren sin una extensión de Windows.',
    codec: 'hevc',
    quality: 24,
    speed: 'balanced',
    maxHeight: null,
    maxFps: null,
    audioKbps: 128,
  },
};

/** Alturas a las que se puede bajar además del tope del preset. */
export const COMPRESSION_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240] as const;

/** 1 MB = 1024 × 1024 bytes, como lo muestra el Explorador de Windows. */
export const BYTES_PER_MB = 1024 * 1024;

/** Límites del modo «que pese como mucho». */
export const TARGET_SIZE_MIN_MB = 5;
export const TARGET_SIZE_MAX_MB = 4000;

/** Atajos del modo tamaño objetivo: un poco por debajo del límite de cada servicio. */
export const TARGET_SIZE_SHORTCUTS = [
  { id: 'mail', label: 'Mail', megabytes: 24 },
  { id: 'whatsapp', label: 'WhatsApp', megabytes: 95 },
  { id: 'cloud', label: 'Teams / Drive', megabytes: 250 },
] as const;

export const compressionTargetSchema = z.discriminatedUnion('mode', [
  /** Calidad constante: la del preset. */
  z.object({ mode: z.literal('quality') }),
  /** Que el archivo pese como mucho tantos MB. */
  z.object({
    mode: z.literal('size'),
    megabytes: z
      .number()
      .min(TARGET_SIZE_MIN_MB, { error: `El tamaño mínimo es ${String(TARGET_SIZE_MIN_MB)} MB.` })
      .max(TARGET_SIZE_MAX_MB, { error: `El tamaño máximo es ${String(TARGET_SIZE_MAX_MB)} MB.` }),
  }),
]);
export type CompressionTarget = z.infer<typeof compressionTargetSchema>;

/**
 * Opciones de una compresión. Es lo mismo que se pide desde la sección
 * Comprimir, al encadenar a una descarga o a una grabación.
 */
export const compressionOptionsSchema = z.object({
  preset: compressionPresetIdSchema,
  target: compressionTargetSchema.default({ mode: 'quality' }),
  /** Bajar más que el tope del preset. null = el del preset. */
  maxHeight: z.number().int().min(100).max(4320).nullable().default(null),
  /** null = el del preset. */
  audioKbps: audioKbpsSchema.nullable().default(null),
});
export type CompressionOptions = z.infer<typeof compressionOptionsSchema>;
