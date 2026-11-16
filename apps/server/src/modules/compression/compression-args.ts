import { COMPRESSION_PRESETS, effectiveAudioKbps, outputVideo } from '@sti-catcher/shared';
import type { CompressionCodec, CompressionOptions, CompressionSpeed } from '@sti-catcher/shared';
import { FFMPEG_BASE_ARGS } from '../../adapters/ffmpeg.ts';
import type { MediaInfo } from '../../adapters/ffprobe.ts';

/**
 * Con qué se codifica: CPU (x264/x265) o la GPU Intel (Quick Sync). Lo decide
 * el server al arrancar, con una codificación de prueba por códec.
 */
export type VideoEncoder = 'cpu' | 'qsv';

export type CompressionArgsOptions = {
  inputPath: string;
  outputPath: string;
  /** Lo que tiene el origen (ffprobe). Tiene que tener video. */
  media: MediaInfo;
  options: CompressionOptions;
  encoder: VideoEncoder;
  /** Bitrate de video del modo tamaño objetivo; null = calidad constante del preset. */
  videoKbps: number | null;
  /**
   * Prefijo del log de dos pasadas (CPU con tamaño objetivo). Va en `tempDir`
   * y empieza con el id del job, como todo temporal (CLAUDE.md).
   */
  passLogPrefix: string;
};

export type CompressionRun = {
  /** analysis: primera de dos pasadas (no escribe el archivo); encode: la que lo escribe. */
  kind: 'analysis' | 'encode';
  args: string[];
};

export type CompressionPlan = {
  /** Una ejecución de ffmpeg, o dos (dos pasadas). */
  runs: CompressionRun[];
  /** Duración del origen, para el porcentaje de cada ejecución. */
  totalDurationSeconds: number | null;
};

const ENCODER_NAMES: Record<VideoEncoder, Record<CompressionCodec, string>> = {
  cpu: { h264: 'libx264', hevc: 'libx265' },
  qsv: { h264: 'h264_qsv', hevc: 'hevc_qsv' },
};

/**
 * Presets de velocidad de cada encoder. x265 es mucho más lento que x264 y la
 * PC servidor es modesta: se usa uno o dos escalones más rápido.
 */
const SPEED_PRESETS: Record<
  VideoEncoder,
  Record<CompressionCodec, Record<CompressionSpeed, string>>
> = {
  cpu: {
    h264: { fast: 'veryfast', balanced: 'medium' },
    hevc: { fast: 'veryfast', balanced: 'fast' },
  },
  qsv: {
    h264: { fast: 'veryfast', balanced: 'medium' },
    hevc: { fast: 'veryfast', balanced: 'medium' },
  },
};

/** Video 8 bits 4:2:0: lo que reproduce todo. QSV quiere NV12 (es el mismo muestreo). */
const PIXEL_FORMAT: Record<VideoEncoder, string> = { cpu: 'yuv420p', qsv: 'nv12' };

const FASTSTART = ['-movflags', '+faststart'];

/** Más de 2 canales → estéreo (AAC en MP4 se reproduce mejor así). */
const downmix = (media: MediaInfo) =>
  media.audio?.channels !== null && media.audio?.channels !== undefined && media.audio.channels > 2
    ? ['-ac', '2']
    : [];

/**
 * Argumentos de ffmpeg para comprimir (D-108). Función pura: el usuario elige
 * un preset y, como mucho, la altura, el audio y el tamaño objetivo, todo
 * validado; acá se traduce a argumentos fijos.
 *
 * - Calidad constante: CRF (CPU) o ICQ `-global_quality` (QSV) con el RF del preset.
 * - Tamaño objetivo en CPU: dos pasadas con el bitrate calculado (clava el tamaño).
 * - Tamaño objetivo en QSV: una pasada con bitrate variable; el runner controla
 *   el tamaño final y reintenta más bajo si se pasa (QSV no tiene dos pasadas).
 *
 * Siempre recodifica, aunque el origen ya sea H.264: comprimir es justamente eso.
 */
export function buildCompressionArgs(params: CompressionArgsOptions): CompressionPlan {
  const { media, options, encoder, videoKbps } = params;
  if (!media.video) throw new Error('No se puede comprimir un archivo sin video');
  const preset = COMPRESSION_PRESETS[options.preset];
  const out = outputVideo(
    {
      width: media.video.width,
      height: media.video.height,
      frameRate: media.video.frameRate,
      durationSeconds: media.durationSeconds,
      hasAudio: media.audio !== null,
    },
    options,
  );

  // Escala por alto con ancho par automático (-2): ffmpeg ya giró los videos verticales,
  // así que el ancho lo calcula sobre la imagen como se ve.
  const filters = [
    ...(out.scaled ? [`scale=-2:${String(out.height)}:flags=lanczos`] : []),
    ...(out.fpsCap !== null ? [`fps=${String(out.fpsCap)}`] : []),
    `format=${PIXEL_FORMAT[encoder]}`,
  ];
  const codec = [
    '-c:v',
    ENCODER_NAMES[encoder][preset.codec],
    '-preset',
    SPEED_PRESETS[encoder][preset.codec][preset.speed],
    // hvc1: la etiqueta que piden QuickTime, iPhone y el Explorador para abrir H.265 en MP4.
    ...(preset.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    ...(preset.codec === 'hevc' && encoder === 'cpu' ? ['-x265-params', 'log-level=error'] : []),
  ];
  const rate = rateControl(encoder, preset.quality, videoKbps);
  const video = ['-vf', filters.join(','), ...codec, ...rate];
  const audio = [
    '-c:a',
    'aac',
    '-b:a',
    `${String(effectiveAudioKbps(options))}k`,
    ...downmix(media),
  ];
  const input = [...FFMPEG_BASE_ARGS, '-i', params.inputPath];

  const encodeArgs = (pass: string[]) => [
    ...input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...video,
    ...pass,
    ...audio,
    ...FASTSTART,
    params.outputPath,
  ];

  if (encoder === 'cpu' && videoKbps !== null) {
    const passLog = ['-passlogfile', params.passLogPrefix];
    return {
      runs: [
        {
          kind: 'analysis',
          // La primera pasada solo mide: sin audio y sin archivo de salida.
          args: [
            ...input,
            '-map',
            '0:v:0',
            ...video,
            '-pass',
            '1',
            ...passLog,
            '-an',
            '-f',
            'null',
            '-',
          ],
        },
        { kind: 'encode', args: encodeArgs(['-pass', '2', ...passLog]) },
      ],
      totalDurationSeconds: media.durationSeconds,
    };
  }
  return {
    runs: [{ kind: 'encode', args: encodeArgs([]) }],
    totalDurationSeconds: media.durationSeconds,
  };
}

function rateControl(encoder: VideoEncoder, quality: number, videoKbps: number | null): string[] {
  const q = String(quality);
  if (videoKbps === null) {
    return encoder === 'cpu' ? ['-crf', q] : ['-global_quality', q];
  }
  const kbps = (value: number) => `${String(Math.round(value))}k`;
  if (encoder === 'cpu') return ['-b:v', kbps(videoKbps)];
  // QSV en una pasada: bitrate variable con techo, para que no se dispare en las escenas difíciles.
  return [
    '-b:v',
    kbps(videoKbps),
    '-maxrate',
    kbps(videoKbps * 1.5),
    '-bufsize',
    kbps(videoKbps * 2),
  ];
}
