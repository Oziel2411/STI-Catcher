import { CONVERSION_PRESETS, SCALE_HEIGHTS } from '@sti-catcher/shared';
import type { ConversionPresetId, GifLimits, GifOptions, SourceMedia } from '@sti-catcher/shared';

/** Grupos en los que se muestran los presets. */
export const PRESET_GROUPS: { title: string; ids: ConversionPresetId[] }[] = [
  { title: 'Video', ids: ['mp4', 'webm', 'mkv', 'mov', 'avi'] },
  { title: 'Animación', ids: ['gif'] },
  { title: 'Solo audio', ids: ['mp3', 'm4a', 'wav'] },
];

/** Preset elegido por defecto: MP4 si hay video, si no MP3. */
export function defaultPreset(available: readonly ConversionPresetId[]): ConversionPresetId | null {
  if (available.includes('mp4')) return 'mp4';
  if (available.includes('mp3')) return 'mp3';
  return available[0] ?? null;
}

/** Alturas a las que se puede escalar: solo menores que la original. */
export function scaleOptions(sourceHeight: number | null): number[] {
  if (sourceHeight === null) return [];
  return SCALE_HEIGHTS.filter((height) => height < sourceHeight);
}

export const isScalable = (preset: ConversionPresetId) => CONVERSION_PRESETS[preset].scalable;

/** Opciones de FPS y ancho para el GIF, dentro de los topes del server. */
export const gifFpsOptions = (limits: GifLimits) =>
  [5, 8, 10, 12, 15, 20, 25, 30].filter((fps) => fps <= limits.maxFps);

export function gifWidthOptions(limits: GifLimits, sourceWidth: number | null): number[] {
  const max = Math.min(limits.maxWidth, sourceWidth ?? limits.maxWidth);
  const options = [240, 320, 400, 480, 640, 800, 1024, 1280, 1920].filter((w) => w <= max);
  return options.length > 0 ? options : [max];
}

/** GIF por defecto: desde el inicio, lo más largo que permite el tope. */
export function defaultGif(media: SourceMedia, limits: GifLimits): GifOptions {
  const duration = media.durationSeconds ?? limits.maxSeconds;
  const widths = gifWidthOptions(limits, media.width);
  const width = widths.includes(limits.defaultWidth)
    ? limits.defaultWidth
    : (widths.at(-1) ?? limits.defaultWidth);
  return {
    startSeconds: 0,
    endSeconds: Math.round(Math.min(duration, limits.maxSeconds) * 10) / 10,
    fps: Math.min(limits.defaultFps, limits.maxFps),
    width,
  };
}

/**
 * Problemas del GIF elegido, en español, para mostrar antes de enviar. El
 * server valida igual (estos mensajes son para no tener que esperar el error).
 */
export function gifProblems(gif: GifOptions, media: SourceMedia, limits: GifLimits): string[] {
  const problems: string[] = [];
  const length = gif.endSeconds - gif.startSeconds;
  if (!(gif.startSeconds >= 0)) problems.push('El inicio no puede ser negativo.');
  if (!(length > 0)) problems.push('El fin tiene que ser posterior al inicio.');
  if (media.durationSeconds !== null && gif.endSeconds > media.durationSeconds + 0.1) {
    problems.push(
      `El video dura ${media.durationSeconds.toFixed(1).replace('.', ',')} s: el fin no puede ser posterior.`,
    );
  }
  if (length > limits.maxSeconds + 0.1) {
    problems.push(`El GIF puede durar como máximo ${String(limits.maxSeconds)} s.`);
  }
  return problems;
}
