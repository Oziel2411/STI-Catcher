import {
  conversionPresetIdSchema,
  conversionSourceResponseSchema,
  gifOptionsSchema,
  isActiveStatus,
} from '@sti-catcher/shared';
import type {
  ConversionPresetId,
  ConversionSourceResponse,
  GifLimits,
  GifOptions,
  Job,
  JobEvent,
} from '@sti-catcher/shared';
import { z } from 'zod';
import { defaultGif, defaultPreset, gifProblems, gifWidthOptions, isScalable } from './convert.ts';
import { formatBytes, formatDuration } from './format.ts';
import { applyJobEvent, STATUS_LABELS } from './jobs.ts';

/**
 * Un archivo de la lista de Convertir (SPEC §7, mockup 2e). Recorre:
 * uploading → analyzing → ready → job; failed si falla la subida o el análisis.
 * Los que vienen del historial empiezan en analyzing.
 */
export type ConvertItemStatus = 'uploading' | 'analyzing' | 'ready' | 'job' | 'failed';

export type ConvertItem = {
  /** Id local de la lista (no es un job). */
  id: string;
  name: string;
  sizeBytes: number | null;
  status: ConvertItemStatus;
  uploadedBytes: number;
  /** Job del archivo de origen (subido o del historial), cuando se conoce. */
  sourceJobId: string | null;
  source: ConversionSourceResponse | null;
  preset: ConversionPresetId | null;
  maxHeight: number | null;
  gif: GifOptions | null;
  /** Job de la conversión y su último estado (por SSE). */
  jobId: string | null;
  job: Job | null;
  error: string | null;
};

const base = {
  uploadedBytes: 0,
  sourceJobId: null,
  source: null,
  preset: null,
  maxHeight: null,
  gif: null,
  jobId: null,
  job: null,
  error: null,
} as const;

export function newUploadItem(id: string, file: { name: string; size: number }): ConvertItem {
  return { ...base, id, name: file.name, sizeBytes: file.size, status: 'uploading' };
}

export function newHistoryItem(id: string, sourceJobId: string): ConvertItem {
  return {
    ...base,
    id,
    name: 'Archivo del historial',
    sizeBytes: null,
    status: 'analyzing',
    sourceJobId,
  };
}

/**
 * El server ya analizó el archivo: queda listo con el formato por defecto
 * (MP4 si hay video, si no MP3). Si el ítem ya tenía un formato elegido (por
 * ejemplo, al recargar la página) y sigue siendo válido, se conserva.
 */
export function withSource(
  item: ConvertItem,
  source: ConversionSourceResponse,
  limits: GifLimits,
): ConvertItem {
  const keep = item.preset !== null && source.presets.includes(item.preset);
  return {
    ...item,
    status: 'ready',
    name: source.job.title ?? item.name,
    sizeBytes: source.job.sizeBytes ?? item.sizeBytes,
    source,
    preset: keep ? item.preset : defaultPreset(source.presets),
    maxHeight: keep ? item.maxHeight : null,
    gif: keep && item.gif ? item.gif : defaultGif(source.media, limits),
    error: null,
  };
}

const SHORT_NAMES: Record<ConversionPresetId, string> = {
  mp4: 'MP4',
  webm: 'WebM',
  mkv: 'MKV',
  mov: 'MOV',
  avi: 'AVI',
  gif: 'GIF',
  mp3: 'MP3',
  m4a: 'M4A',
  wav: 'WAV',
};

/** Etiqueta del formato elegido: "MP4 · 720p", "GIF", "MP3". */
export function formatTag(preset: ConversionPresetId | null, maxHeight: number | null): string {
  if (preset === null) return '—';
  const name = SHORT_NAMES[preset];
  return maxHeight !== null && isScalable(preset) ? `${name} · ${String(maxHeight)}p` : name;
}

/** Problemas que impiden convertir este ítem (hoy, solo los del GIF). */
export function itemProblems(item: ConvertItem, limits: GifLimits): string[] {
  if (item.preset !== 'gif' || !item.gif || !item.source) return [];
  return gifProblems(item.gif, item.source.media, limits);
}

export const isConvertible = (item: ConvertItem, limits: GifLimits) =>
  item.status === 'ready' && item.preset !== null && itemProblems(item, limits).length === 0;

/** El trabajo de conversión del ítem sigue en curso (no se puede quitar ni cambiar). */
export const isConverting = (item: ConvertItem) =>
  item.status === 'job' && (item.job === null || isActiveStatus(item.job.status));

/**
 * "Usar este formato en todos": copia el formato y la resolución del ítem a
 * los demás listos, solo donde tiene sentido (un archivo de solo audio no
 * recibe MP4; la resolución solo si es menor que la del archivo). Para el
 * GIF se copian fps y ancho; inicio y fin son de cada archivo.
 */
export function applyFormatToAll(items: ConvertItem[], fromId: string): ConvertItem[] {
  const from = items.find((item) => item.id === fromId);
  if (!from?.preset) return items;
  const preset = from.preset;
  return items.map((item) => {
    if (item.id === fromId || item.status !== 'ready' || !item.source) return item;
    if (!item.source.presets.includes(preset)) return item;
    const sourceHeight = item.source.media.height;
    const maxHeight =
      from.maxHeight !== null && sourceHeight !== null && from.maxHeight < sourceHeight
        ? from.maxHeight
        : null;
    let gif = item.gif;
    if (preset === 'gif' && from.gif && item.gif) {
      const width =
        from.gif.width <= (item.source.media.width ?? Infinity) ? from.gif.width : item.gif.width;
      gif = { ...item.gif, fps: from.gif.fps, width };
    }
    return { ...item, preset, maxHeight, gif };
  });
}

/** Las opciones de ancho del GIF para un ítem (para el select). */
export const itemGifWidths = (item: ConvertItem, limits: GifLimits) =>
  gifWidthOptions(limits, item.source?.media.width ?? null);

/** Segunda línea de un ítem: "52:18 · 1,4 GB · listo". */
export function itemMeta(item: ConvertItem): string {
  const duration = item.source ? formatDuration(item.source.media.durationSeconds) : null;
  const size = item.sizeBytes !== null ? formatBytes(item.sizeBytes) : null;
  const state =
    item.status === 'ready'
      ? 'listo'
      : item.status === 'analyzing'
        ? 'analizando…'
        : item.status === 'uploading'
          ? 'subiendo'
          : item.status === 'job' && item.job
            ? STATUS_LABELS[item.job.status].toLowerCase()
            : null;
  return [duration, size, state]
    .filter((part): part is string => part !== null && part !== '—')
    .join(' · ');
}

/** Aplica un evento SSE a los ítems que siguen ese job. Misma lista si no cambió nada. */
export function applyEventToItems(items: ConvertItem[], event: JobEvent): ConvertItem[] {
  const next = items.map((item) => {
    if (item.jobId === null) return item;
    const jobId = event.type === 'job.updated' ? event.job.id : event.jobId;
    if (jobId !== item.jobId) return item;
    if (event.type === 'job.deleted') {
      return {
        ...item,
        job: null,
        jobId: null,
        status: 'failed' as const,
        error: 'El trabajo se borró.',
      };
    }
    const job = applyJobEvent(item.job, event);
    if (job === item.job) return item;
    return { ...item, job };
  });
  return next.some((item, index) => item !== items[index]) ? next : items;
}

/** `?origen=a,b,c` (links "Convertir" del historial): ids válidos, sin repetir. */
export function parseOrigin(value: string | null): string[] {
  if (!value) return [];
  const ids = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => z.uuid().safeParse(part).success);
  return [...new Set(ids)];
}

// --- Guardado en sessionStorage --------------------------------------------
// Para que recargar la página no pierda la lista. Los File no se pueden
// guardar: lo que se estaba subiendo se pierde (y se avisa). Lo demás se
// vuelve a analizar al cargar, conservando el formato elegido.

const storedItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  sizeBytes: z.number().nullable(),
  status: z.enum(['analyzing', 'ready', 'job', 'failed']),
  sourceJobId: z.uuid().nullable(),
  preset: conversionPresetIdSchema.nullable(),
  maxHeight: z.number().nullable(),
  gif: gifOptionsSchema.nullable(),
  jobId: z.uuid().nullable(),
  error: z.string().nullable(),
  source: conversionSourceResponseSchema.nullable(),
});
const storedBatchSchema = z.array(storedItemSchema);

export function serializeBatch(items: ConvertItem[]): string {
  const stored = items
    .filter((item) => item.status !== 'uploading')
    .map((item) => ({
      id: item.id,
      name: item.name,
      sizeBytes: item.sizeBytes,
      status: item.status as Exclude<ConvertItemStatus, 'uploading'>,
      sourceJobId: item.sourceJobId,
      preset: item.preset,
      maxHeight: item.maxHeight,
      gif: item.gif,
      jobId: item.jobId,
      error: item.error,
      source: item.source,
    }));
  return JSON.stringify(stored);
}

/** Lo guardado, listo para retomar. Los listos vuelven a analizarse (el archivo pudo expirar). */
export function restoreBatch(raw: string | null): ConvertItem[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = storedBatchSchema.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.map((stored) => ({
    ...base,
    ...stored,
    status: stored.status === 'ready' ? 'analyzing' : stored.status,
  }));
}
