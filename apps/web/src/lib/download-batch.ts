import {
  CONVERSION_PRESETS,
  conversionPresetIdSchema,
  gifOptionsSchema,
  httpUrlSchema,
  isActiveStatus,
  probeResponseSchema,
  videoModeSchema,
} from '@sti-catcher/shared';
import type {
  ConversionPresetId,
  DownloadRequest,
  GifLimits,
  GifOptions,
  Job,
  JobEvent,
  ProbeResponse,
  SourceMedia,
  VideoMode,
} from '@sti-catcher/shared';
import { z } from 'zod';
import { defaultGif, gifProblems } from './convert.ts';
import { defaultHeight, defaultMode } from './download.ts';
import { applyJobEvent } from './jobs.ts';

/**
 * Un link de la lista de Descargar (mockup 2a). Recorre analyzing → ready →
 * job; failed si el análisis falla (o es una transmisión en vivo).
 *
 * El formato es un preset de conversión: MP4, MP3 y M4A los baja yt-dlp
 * directo; el resto (WebM, MOV, MKV, AVI, WAV, GIF) se baja y se convierte
 * solo al terminar (`then`, D-093).
 */
export type DownloadItemStatus = 'analyzing' | 'ready' | 'job' | 'failed';

export type DownloadItem = {
  /** Id local de la lista (no es un job). */
  id: string;
  url: string;
  status: DownloadItemStatus;
  probe: ProbeResponse | null;
  checked: boolean;
  preset: ConversionPresetId | null;
  /** Altura máxima de lo que se baja (video y GIF). null = la mejor. */
  maxHeight: number | null;
  /** Solo MP4. */
  videoMode: VideoMode;
  gif: GifOptions | null;
  /** La descarga y su último estado; la conversión encadenada, si hay. */
  jobId: string | null;
  job: Job | null;
  followUp: Job | null;
  error: string | null;
};

/** Lo que se ve en la columna Estado. */
export type RowState =
  | 'analyzing'
  | 'ready'
  | 'live'
  | 'failed'
  | 'queued'
  | 'running'
  | 'converting'
  | 'done'
  | 'cancelled';

/** Lo que baja yt-dlp directo, sin conversión. */
const DIRECT_PRESETS = ['mp4', 'mp3', 'm4a'] as const;
type DirectPreset = (typeof DIRECT_PRESETS)[number];
const isDirect = (preset: ConversionPresetId): preset is DirectPreset =>
  (DIRECT_PRESETS as readonly string[]).includes(preset);

/** Para un GIF no hace falta bajar más que esto (el GIF sale de 800 px como mucho). */
const GIF_SOURCE_HEIGHT = 720;

export const LIVE_MESSAGE =
  'Es una transmisión en vivo: no se puede descargar mientras está en curso.';

/** Grupos del selector de formato (mismo orden que Convertir). */
export const FORMAT_GROUPS: { title: string; ids: ConversionPresetId[] }[] = [
  { title: 'Video', ids: ['mp4', 'webm', 'mov', 'mkv', 'avi'] },
  { title: 'Animación', ids: ['gif'] },
  { title: 'Solo audio', ids: ['mp3', 'm4a', 'wav'] },
];

const GROUP_PREFIX: Record<ConversionPresetId, string> = {
  mp4: 'Video',
  webm: 'Video',
  mov: 'Video',
  mkv: 'Video',
  avi: 'Video',
  gif: 'Animación',
  mp3: 'Solo audio',
  m4a: 'Solo audio',
  wav: 'Solo audio',
};

/** "Video · MP4", "Animación · GIF". */
export const formatLabel = (preset: ConversionPresetId) =>
  `${GROUP_PREFIX[preset]} · ${CONVERSION_PRESETS[preset].extension.toUpperCase()}`;

/** Nombre corto del formato ("MP4", "GIF"). */
export const presetShortName = (preset: ConversionPresetId) =>
  CONVERSION_PRESETS[preset].extension.toUpperCase();

/** Si un formato se puede pedir para este video (un audio no da un GIF). */
export function presetAvailable(probe: ProbeResponse, preset: ConversionPresetId): boolean {
  return CONVERSION_PRESETS[preset].needs === 'video' ? probe.hasVideo : probe.hasAudio;
}

// --- Pegar links ---------------------------------------------------------------

export type ParsedLinks = {
  /** Links nuevos, normalizados, sin repetir (ni entre sí ni con la lista). */
  urls: string[];
  /** Lo que no es un link http/https. */
  invalid: { line: number; text: string }[];
  /** Renglones que no se agregaron por estar repetidos. */
  duplicates: number;
};

/**
 * Texto pegado → links. Uno o varios por renglón (separados por espacios).
 * Se valida con el mismo esquema que usa el server.
 */
export function parseLinks(text: string, existing: readonly string[]): ParsedLinks {
  const seen = new Set(existing);
  const urls: string[] = [];
  const invalid: ParsedLinks['invalid'] = [];
  let duplicates = 0;
  text.split(/\r?\n/).forEach((line, index) => {
    for (const token of line.split(/\s+/).filter((part) => part !== '')) {
      const parsed = httpUrlSchema.safeParse(token);
      if (!parsed.success) {
        invalid.push({ line: index + 1, text: token });
      } else if (seen.has(parsed.data)) {
        duplicates++;
      } else {
        seen.add(parsed.data);
        urls.push(parsed.data);
      }
    }
  });
  return { urls, invalid, duplicates };
}

// --- Ítems -----------------------------------------------------------------------

export function newLinkItem(id: string, url: string): DownloadItem {
  return {
    id,
    url,
    status: 'analyzing',
    probe: null,
    checked: false,
    preset: null,
    maxHeight: null,
    videoMode: 'compat',
    gif: null,
    jobId: null,
    job: null,
    followUp: null,
    error: null,
  };
}

/** Lo que se sabe del video, con la forma que usan las opciones del GIF. */
export function probeMedia(probe: ProbeResponse): SourceMedia {
  return {
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
    durationSeconds: probe.durationSeconds,
    width: null,
    height: probe.resolutions[0]?.height ?? null,
    videoCodec: null,
    audioCodec: null,
  };
}

/**
 * Llegó el análisis: queda listo con el formato por defecto (MP4 si hay
 * video, si no MP3). Si el formato ya estaba elegido (p. ej. "aplicar a los
 * seleccionados" antes de que terminara) y sirve, se respeta.
 */
export function withProbe(
  item: DownloadItem,
  probe: ProbeResponse,
  limits: GifLimits,
): DownloadItem {
  if (probe.isLive) {
    return { ...item, probe, status: 'failed', checked: false, error: LIVE_MESSAGE };
  }
  const preset =
    item.preset !== null && presetAvailable(probe, item.preset)
      ? item.preset
      : probe.hasVideo
        ? 'mp4'
        : 'mp3';
  return {
    ...item,
    probe,
    status: 'ready',
    error: null,
    preset,
    maxHeight: defaultHeight(probe),
    videoMode: defaultMode(probe),
    gif: probe.hasVideo ? defaultGif(probeMedia(probe), limits) : null,
  };
}

/** Problemas que impiden empezar (por ahora, solo el GIF). */
export function itemProblems(item: DownloadItem, limits: GifLimits): string[] {
  if (item.preset !== 'gif' || !item.probe || !item.gif) return [];
  return gifProblems(item.gif, probeMedia(item.probe), limits);
}

export const isStartable = (item: DownloadItem, limits: GifLimits) =>
  item.status === 'ready' &&
  item.probe !== null &&
  item.preset !== null &&
  itemProblems(item, limits).length === 0;

/** Pedido para `POST /api/jobs/download`. */
export function downloadRequest(item: DownloadItem): DownloadRequest | null {
  const { probe, preset } = item;
  if (!probe || !preset) return null;
  const common = { url: probe.url, title: probe.title };
  if (isDirect(preset)) {
    return {
      ...common,
      format: preset,
      maxHeight: preset === 'mp4' ? item.maxHeight : null,
      videoMode: item.videoMode,
    };
  }
  if (preset === 'gif') {
    if (!item.gif) return null;
    return {
      ...common,
      maxHeight: GIF_SOURCE_HEIGHT,
      then: { preset, maxHeight: null, gif: item.gif },
    };
  }
  const needsVideo = CONVERSION_PRESETS[preset].needs === 'video';
  return {
    ...common,
    maxHeight: needsVideo ? item.maxHeight : null,
    then: { preset, maxHeight: null },
  };
}

// --- Estado de la fila --------------------------------------------------------------

/** Qué se ve en Estado, mirando la descarga y su conversión encadenada. */
export function rowState(item: DownloadItem): RowState {
  if (item.status === 'analyzing') return 'analyzing';
  if (item.status === 'ready') return 'ready';
  if (item.status === 'failed') return item.probe?.isLive ? 'live' : 'failed';
  const { job, followUp } = item;
  if (!job) return 'queued';
  if (job.status === 'queued') return 'queued';
  if (job.status === 'running') return 'running';
  if (job.status === 'failed' || job.status === 'expired') return 'failed';
  if (job.status === 'cancelled') return 'cancelled';
  // done: si había conversión, manda la conversión.
  if (job.followUpJobId === null) return 'done';
  if (!followUp || isActiveStatus(followUp.status)) return 'converting';
  if (followUp.status === 'done') return 'done';
  return followUp.status === 'cancelled' ? 'cancelled' : 'failed';
}

/** El job cuyo archivo es el resultado (la conversión, si hubo). */
export function resultJob(item: DownloadItem): Job | null {
  return item.followUp ?? item.job;
}

/** El job en curso que se cancela desde la fila. */
export function activeJob(item: DownloadItem): Job | null {
  if (item.followUp && isActiveStatus(item.followUp.status)) return item.followUp;
  if (item.job && isActiveStatus(item.job.status)) return item.job;
  return null;
}

/** Mensaje de error de la fila (del análisis, de la descarga o de la conversión). */
export function rowError(item: DownloadItem): string | null {
  if (item.status === 'failed') return item.error;
  return item.followUp?.error ?? item.job?.error ?? item.error;
}

/** Ids a seguir por SSE: descargas y conversiones que todavía pueden cambiar. */
export function trackedJobIds(items: readonly DownloadItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.jobId === null) continue;
    const job = item.job;
    if (!job || isActiveStatus(job.status)) ids.push(item.jobId);
    else if (
      job.followUpJobId !== null &&
      (!item.followUp || isActiveStatus(item.followUp.status))
    ) {
      ids.push(job.followUpJobId);
    }
  }
  return [...new Set(ids)].sort();
}

/** Aplica un evento SSE. Misma lista si no cambió nada. */
export function applyEventToItems(items: DownloadItem[], event: JobEvent): DownloadItem[] {
  const id = event.type === 'job.updated' ? event.job.id : event.jobId;
  const next = items.map((item) => {
    if (item.jobId === id) {
      if (event.type === 'job.deleted') {
        return {
          ...item,
          status: 'failed' as const,
          job: null,
          jobId: null,
          error: 'El trabajo se borró.',
        };
      }
      const job = event.type === 'job.updated' ? event.job : applyJobEvent(item.job, event);
      return job === item.job ? item : { ...item, job };
    }
    const followUpId = item.job?.followUpJobId ?? null;
    if (followUpId !== null && followUpId === id && event.type !== 'job.deleted') {
      const followUp =
        event.type === 'job.updated' ? event.job : applyJobEvent(item.followUp, event);
      return followUp === item.followUp ? item : { ...item, followUp };
    }
    return item;
  });
  return next.some((item, index) => item !== items[index]) ? next : items;
}

// --- Formato para varios -----------------------------------------------------------

/**
 * "Descargar N listos": los tildados que están listos; si no hay ninguno
 * tildado, todos los listos.
 */
export function startTargets(items: readonly DownloadItem[], limits: GifLimits): DownloadItem[] {
  const startable = items.filter((item) => isStartable(item, limits));
  const checked = startable.filter((item) => item.checked);
  return checked.length > 0 ? checked : startable;
}

/** Los tildados que todavía no empezaron (a los que se les puede cambiar el formato). */
export const editableChecked = (items: readonly DownloadItem[]) =>
  items.filter((item) => item.checked && (item.status === 'ready' || item.status === 'analyzing'));

/** Pone el formato en los tildados donde tiene sentido (un audio no recibe un GIF). */
export function applyPresetToChecked(
  items: DownloadItem[],
  preset: ConversionPresetId,
): DownloadItem[] {
  return items.map((item) => {
    if (!item.checked) return item;
    if (item.status === 'analyzing') return { ...item, preset };
    if (item.status !== 'ready' || !item.probe || !presetAvailable(item.probe, preset)) return item;
    return { ...item, preset };
  });
}

// --- Guardado en sessionStorage -----------------------------------------------------
// Recargar la página no pierde la lista. Lo que estaba analizándose se vuelve
// a analizar; las descargas se retoman por SSE (el server manda su estado).

const storedItemSchema = z.object({
  id: z.string(),
  url: z.string(),
  status: z.enum(['analyzing', 'ready', 'job', 'failed']),
  probe: probeResponseSchema.nullable(),
  checked: z.boolean(),
  preset: conversionPresetIdSchema.nullable(),
  maxHeight: z.number().nullable(),
  videoMode: videoModeSchema,
  gif: gifOptionsSchema.nullable(),
  jobId: z.uuid().nullable(),
  error: z.string().nullable(),
});

export function serializeLinks(items: readonly DownloadItem[]): string {
  return JSON.stringify(
    items.map((item) => ({
      id: item.id,
      url: item.url,
      status: item.status,
      probe: item.probe,
      checked: item.checked,
      preset: item.preset,
      maxHeight: item.maxHeight,
      videoMode: item.videoMode,
      gif: item.gif,
      jobId: item.jobId,
      error: item.error,
    })),
  );
}

export function restoreLinks(raw: string | null): DownloadItem[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = z.array(storedItemSchema).safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.map((stored) => ({ ...stored, job: null, followUp: null }));
}
