import {
  BYTES_PER_MB,
  COMPRESSION_HEIGHTS,
  COMPRESSION_PRESETS,
  type CompressionCodec,
  type CompressionOptions,
} from './compression.ts';

/**
 * Cuentas de tamaño de la compresión (D-108). Funciones puras: la web las usa
 * para mostrar la estimación mientras se eligen las opciones, y el server las
 * repite para validar y para calcular el bitrate.
 */

/** Lo que hace falta saber del original (de ffprobe). */
export type CompressionSource = {
  width: number;
  height: number;
  /** null cuando ffprobe no la da (p. ej. un WebM de MediaRecorder, de cuadros variables). */
  frameRate: number | null;
  durationSeconds: number | null;
  /** Sin audio, todo el tamaño va al video (p. ej. una grabación sin sonido). */
  hasAudio: boolean;
};

export type OutputVideo = {
  width: number;
  height: number;
  /** Tope de cuadros a aplicar; null = dejar los del original. */
  fpsCap: number | null;
  /** Cuadros por segundo con los que se hacen las cuentas. */
  fpsForMath: number;
  scaled: boolean;
};

/** Cuadros por segundo supuestos cuando el original no los informa. */
const DEFAULT_FPS = 30;

/** Tamaño y cuadros de la salida: solo se baja, nunca se sube. */
export function outputVideo(source: CompressionSource, options: CompressionOptions): OutputVideo {
  const preset = COMPRESSION_PRESETS[options.preset];
  const caps = [preset.maxHeight, options.maxHeight].filter((h): h is number => h !== null);
  const cap = caps.length > 0 ? Math.min(...caps) : null;
  const scaled = cap !== null && source.height > cap;
  const height = scaled ? cap : source.height;
  // Ancho par manteniendo la proporción (H.264 y H.265 lo exigen).
  const width = scaled
    ? Math.max(2, Math.round((source.width * height) / source.height / 2) * 2)
    : source.width;
  const needsFpsCap =
    preset.maxFps !== null &&
    (source.frameRate === null || source.frameRate > preset.maxFps + 0.01);
  const fpsCap = needsFpsCap ? preset.maxFps : null;
  return {
    width,
    height,
    fpsCap,
    fpsForMath: fpsCap ?? source.frameRate ?? DEFAULT_FPS,
    scaled,
  };
}

export function effectiveAudioKbps(options: CompressionOptions): number {
  return options.audioKbps ?? COMPRESSION_PRESETS[options.preset].audioKbps;
}

/** Bitrate de audio de la salida: 0 si el original no tiene audio. */
export function outputAudioKbps(source: CompressionSource, options: CompressionOptions): number {
  return source.hasAudio ? effectiveAudioKbps(options) : 0;
}

/** Cuánto rinde cada códec respecto de H.264 (H.265 ≈ 40 % menos a igual calidad). */
const CODEC_FACTOR: Record<CompressionCodec, number> = { h264: 1, hevc: 0.6 };

/**
 * Bits por píxel y cuadro por debajo de los cuales la imagen se rompe en
 * bloques (H.264). Es el piso para decidir si un tamaño objetivo se puede
 * alcanzar a una resolución.
 */
const MIN_BITS_PER_PIXEL = 0.02;

/** Lo que agrega el contenedor MP4 (índices, encabezados): ~1 %. */
const CONTAINER_OVERHEAD = 0.01;

/**
 * Margen al apuntar a un tamaño: la GPU (una pasada) se suele pasar, así que
 * apunta al 90 %; la CPU en dos pasadas clava el bitrate y deja solo un 3 %.
 */
export const TARGET_MARGIN = { gpu: 0.9, cpu: 0.97 } as const;

const kbpsFor = (pixelsPerSecond: number, bitsPerPixel: number) =>
  (pixelsPerSecond * bitsPerPixel) / 1000;

/** Bitrate de video mínimo aceptable para esa salida. */
export function minVideoKbps(video: OutputVideo, codec: CompressionCodec): number {
  return Math.round(
    kbpsFor(video.width * video.height * video.fpsForMath, MIN_BITS_PER_PIXEL) *
      CODEC_FACTOR[codec],
  );
}

/** Bitrate de video para que el total (video + audio + contenedor) pese `targetBytes`. */
export function videoKbpsForTarget(params: {
  targetBytes: number;
  durationSeconds: number;
  audioKbps: number;
  margin: number;
}): number {
  const totalKbps =
    (params.targetBytes * 8 * params.margin * (1 - CONTAINER_OVERHEAD)) /
    1000 /
    params.durationSeconds;
  return Math.floor(totalKbps - params.audioKbps);
}

export type TargetSizePlan =
  | { ok: true; videoKbps: number }
  | { ok: false; reason: 'no-duration' }
  | {
      ok: false;
      reason: 'too-small';
      /** Altura más alta a la que sí se llega; null si ni a la más chica. */
      suggestedHeight: number | null;
    };

/**
 * Bitrate para el modo «que pese como mucho», o por qué no se puede: sin
 * duración no hay cuenta posible, y por debajo del piso la imagen se
 * destruye (se sugiere una resolución más baja).
 */
export function planTargetSize(
  source: CompressionSource,
  options: CompressionOptions,
  margin: number,
): TargetSizePlan {
  if (options.target.mode !== 'size') throw new Error('planTargetSize es solo para el modo tamaño');
  const duration = source.durationSeconds;
  if (duration === null || duration <= 0) return { ok: false, reason: 'no-duration' };
  const codec = COMPRESSION_PRESETS[options.preset].codec;
  const videoKbps = videoKbpsForTarget({
    targetBytes: options.target.megabytes * BYTES_PER_MB,
    durationSeconds: duration,
    audioKbps: outputAudioKbps(source, options),
    margin,
  });
  const video = outputVideo(source, options);
  if (videoKbps >= minVideoKbps(video, codec)) return { ok: true, videoKbps };

  const suggestedHeight =
    COMPRESSION_HEIGHTS.filter((h) => h < video.height).find((h) => {
      const smaller = outputVideo(source, { ...options, maxHeight: h });
      return videoKbps >= minVideoKbps(smaller, codec);
    }) ?? null;
  return { ok: false, reason: 'too-small', suggestedHeight };
}

/**
 * Rango aproximado de bits por píxel y cuadro con calidad constante a RF 22
 * en H.264: abajo, una grabación de pantalla casi quieta; arriba, video de
 * cámara con mucho movimiento. Depende tanto del contenido que solo sirve
 * para dar un orden de magnitud.
 */
const QUALITY_BITS_PER_PIXEL = { low: 0.01, high: 0.12 } as const;
const REFERENCE_RF = 22;

export type SizeEstimate = { minBytes: number; maxBytes: number };

/**
 * Tamaño estimado de la salida. Con tamaño objetivo es el pedido; con
 * calidad constante es un rango aproximado. null sin duración.
 */
export function estimateCompressedSize(
  source: CompressionSource,
  options: CompressionOptions,
): SizeEstimate | null {
  const duration = source.durationSeconds;
  if (duration === null || duration <= 0) return null;
  if (options.target.mode === 'size') {
    const bytes = Math.round(options.target.megabytes * BYTES_PER_MB);
    return { minBytes: Math.round(bytes * TARGET_MARGIN.gpu), maxBytes: bytes };
  }
  const preset = COMPRESSION_PRESETS[options.preset];
  const video = outputVideo(source, options);
  // Cada 6 puntos de RF el tamaño se reduce a la mitad.
  const rfFactor = 2 ** ((REFERENCE_RF - preset.quality) / 6) * CODEC_FACTOR[preset.codec];
  const pixelsPerSecond = video.width * video.height * video.fpsForMath;
  const bytesAt = (bitsPerPixel: number) => {
    const kbps =
      kbpsFor(pixelsPerSecond, bitsPerPixel) * rfFactor + outputAudioKbps(source, options);
    return Math.round(((kbps * 1000) / 8) * duration * (1 + CONTAINER_OVERHEAD));
  };
  return {
    minBytes: bytesAt(QUALITY_BITS_PER_PIXEL.low),
    maxBytes: bytesAt(QUALITY_BITS_PER_PIXEL.high),
  };
}

/**
 * Bitrate del reintento cuando la salida pesó más que el objetivo: se baja en
 * proporción a lo que se pasó, con un 5 % extra de margen.
 */
export function retryVideoKbps(params: {
  previousVideoKbps: number;
  /** El de la salida (0 sin audio: `outputAudioKbps`). */
  audioKbps: number;
  actualBytes: number;
  targetBytes: number;
}): number {
  const totalKbps = params.previousVideoKbps + params.audioKbps;
  const scaled = totalKbps * (params.targetBytes / params.actualBytes) * 0.95;
  return Math.floor(scaled - params.audioKbps);
}
