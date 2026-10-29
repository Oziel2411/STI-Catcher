import { CONVERSION_PRESETS } from '@sti-catcher/shared';
import type { ConversionPresetId, GifOptions } from '@sti-catcher/shared';
import { FFMPEG_BASE_ARGS } from '../../adapters/ffmpeg.ts';
import type { MediaInfo } from '../../adapters/ffprobe.ts';

export type ConversionArgsOptions = {
  preset: ConversionPresetId;
  inputPath: string;
  outputPath: string;
  /** Lo que tiene el origen (ffprobe): decide si se puede copiar sin recodificar. */
  media: MediaInfo;
  /** Escalar hacia abajo a esta altura. Se ignora si el video ya es igual o más chico. */
  maxHeight: number | null;
  /** Obligatorio para el preset GIF (ya validado contra los límites). */
  gif?: GifOptions;
};

export type ConversionPlan = {
  args: string[];
  /** Duración de la salida, para el porcentaje de progreso. */
  totalDurationSeconds: number | null;
  /** copy: solo cambia el contenedor (segundos); encode: recodifica (minutos). */
  mode: 'copy' | 'encode';
};

/** Números para ffmpeg: punto decimal y sin notación científica. */
const seconds = (value: number) => value.toFixed(3);

const H264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'];
const AAC = ['-c:a', 'aac', '-b:a', '192k'];
const VIDEO_MAPS = ['-map', '0:v:0', '-map', '0:a:0?'];
const AUDIO_MAPS = ['-map', '0:a:0', '-vn'];
const FASTSTART = ['-movflags', '+faststart'];

/** Más de 2 canales → estéreo (MP3 no admite más; M4A, por compatibilidad). Mono queda mono. */
const downmix = (media: MediaInfo) =>
  media.audio?.channels !== null && media.audio?.channels !== undefined && media.audio.channels > 2
    ? ['-ac', '2']
    : [];

/**
 * Argumentos de ffmpeg para una conversión (SPEC §7). Función pura: el
 * usuario solo elige un preset de la lista cerrada; acá se traduce a
 * argumentos fijos. Nunca entra texto del cliente.
 *
 * Copia sin recodificar cuando el origen ya cumple: es igual en calidad y
 * tarda segundos en vez de minutos (p. ej. un .mov H.264 de Android → MP4).
 */
export function buildConversionArgs(options: ConversionArgsOptions): ConversionPlan {
  const { preset, inputPath, outputPath, media, maxHeight } = options;
  const video = media.video;
  const needsScale =
    CONVERSION_PRESETS[preset].scalable &&
    maxHeight !== null &&
    video !== null &&
    video.height > maxHeight;
  // -2: ancho par, manteniendo la proporción (H.264 lo exige).
  const scale = needsScale ? ['-vf', `scale=-2:${String(maxHeight)}`] : [];
  const audioCodec = media.audio?.codec ?? null;
  const isPlainH264 =
    video?.codec === 'h264' && (video.pixFmt === null || video.pixFmt === 'yuv420p');
  const audioIsAacOrNone = audioCodec === null || audioCodec === 'aac';

  const plan = (args: string[], mode: ConversionPlan['mode']): ConversionPlan => ({
    args: [...FFMPEG_BASE_ARGS, '-i', inputPath, ...args, outputPath],
    totalDurationSeconds: media.durationSeconds,
    mode,
  });

  switch (preset) {
    case 'mp4':
    case 'mov':
      if (!needsScale && isPlainH264 && audioIsAacOrNone) {
        return plan([...VIDEO_MAPS, '-c', 'copy', ...FASTSTART], 'copy');
      }
      return plan(
        [...VIDEO_MAPS, ...scale, ...H264, ...AAC, ...downmix(media), ...FASTSTART],
        'encode',
      );

    case 'mkv':
      // MKV admite casi cualquier codec: sin escalar, solo se cambia el contenedor.
      if (!needsScale) return plan([...VIDEO_MAPS, '-c', 'copy'], 'copy');
      return plan([...VIDEO_MAPS, ...scale, ...H264, ...AAC], 'encode');

    case 'webm':
      // CRF 32 + bitrate 0 = calidad constante; cpu-used 4 y row-mt para no tardar una eternidad.
      return plan(
        [
          ...VIDEO_MAPS,
          ...scale,
          '-c:v',
          'libvpx-vp9',
          '-crf',
          '32',
          '-b:v',
          '0',
          '-deadline',
          'good',
          '-cpu-used',
          '4',
          '-row-mt',
          '1',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'libopus',
          '-b:a',
          '128k',
          ...downmix(media),
        ],
        'encode',
      );

    case 'avi':
      // MPEG-4 Part 2 con tag XVID + MP3: lo que abren los reproductores y equipos viejos.
      return plan(
        [
          ...VIDEO_MAPS,
          ...scale,
          '-c:v',
          'mpeg4',
          '-q:v',
          '3',
          '-vtag',
          'XVID',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'libmp3lame',
          '-q:a',
          '4',
          '-ac',
          '2',
        ],
        'encode',
      );

    case 'gif':
      return buildGifPlan(options);

    case 'mp3':
      if (audioCodec === 'mp3') return plan([...AUDIO_MAPS, '-c:a', 'copy'], 'copy');
      // VBR calidad 2 (~190 kbps): indistinguible del original para voz y música.
      return plan([...AUDIO_MAPS, '-c:a', 'libmp3lame', '-q:a', '2', ...downmix(media)], 'encode');

    case 'm4a':
      if (audioCodec === 'aac') return plan([...AUDIO_MAPS, '-c:a', 'copy', ...FASTSTART], 'copy');
      return plan([...AUDIO_MAPS, ...AAC, ...downmix(media), ...FASTSTART], 'encode');

    case 'wav':
      // PCM 16 bits: lo que lee cualquier programa de audio. Se conservan canales y frecuencia.
      return plan([...AUDIO_MAPS, '-c:a', 'pcm_s16le'], 'encode');
  }
}

/**
 * GIF con paleta propia en una sola pasada (palettegen + paletteuse): sin
 * esto, ffmpeg usa una paleta genérica de 256 colores y el resultado se ve
 * con bandas y ruido. El recorte (-ss/-t) va antes de -i para que ffmpeg
 * salte directo al inicio sin decodificar lo anterior.
 */
function buildGifPlan({ inputPath, outputPath, gif }: ConversionArgsOptions): ConversionPlan {
  if (!gif) throw new Error('El preset GIF necesita inicio, fin, fps y ancho');
  const duration = gif.endSeconds - gif.startSeconds;
  const filter =
    `[0:v]fps=${String(gif.fps)},scale='min(${String(gif.width)},iw)':-1:flags=lanczos,split[a][b];` +
    '[a]palettegen=stats_mode=diff[p];' +
    '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
  return {
    args: [
      ...FFMPEG_BASE_ARGS,
      '-ss',
      seconds(gif.startSeconds),
      '-t',
      seconds(duration),
      '-i',
      inputPath,
      '-filter_complex',
      filter,
      '-loop',
      '0',
      '-an',
      outputPath,
    ],
    totalDurationSeconds: duration,
    mode: 'encode',
  };
}
