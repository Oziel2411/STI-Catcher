import {
  BYTES_PER_MB,
  COMPRESSION_HEIGHTS,
  COMPRESSION_PRESETS,
  compressionOptionsSchema,
  compressionSourceResponseSchema,
  estimateCompressedSize,
  isActiveStatus,
  outputVideo,
  planTargetSize,
  targetMarginFor,
  targetSizeProblem,
} from '@sti-catcher/shared';
import type {
  CompressionOptions,
  CompressionPresetId,
  CompressionSource,
  CompressionSourceResponse,
  Job,
} from '@sti-catcher/shared';
import { z } from 'zod';
import { formatBytes, formatDuration } from './format.ts';
import { STATUS_LABELS } from './jobs.ts';

/**
 * Un archivo de la lista de Comprimir (D-108). Recorre, igual que Convertir:
 * uploading → analyzing → ready → job; failed si falla la subida o el análisis.
 */
export type CompressItemStatus = 'uploading' | 'analyzing' | 'ready' | 'job' | 'failed';

export type CompressItem = {
  id: string;
  name: string;
  sizeBytes: number | null;
  status: CompressItemStatus;
  uploadedBytes: number;
  sourceJobId: string | null;
  source: CompressionSourceResponse | null;
  options: CompressionOptions;
  jobId: string | null;
  job: Job | null;
  error: string | null;
};

/** Para compartir: lo más pedido en el cuestionario (mail, WhatsApp, plataformas). */
export const DEFAULT_PRESET: CompressionPresetId = 'share-720p';

export const defaultOptions = (preset: CompressionPresetId = DEFAULT_PRESET): CompressionOptions =>
  compressionOptionsSchema.parse({ preset });

const base = {
  uploadedBytes: 0,
  sourceJobId: null,
  source: null,
  jobId: null,
  job: null,
  error: null,
} as const;

export function newUploadItem(id: string, file: { name: string; size: number }): CompressItem {
  return {
    ...base,
    id,
    name: file.name,
    sizeBytes: file.size,
    status: 'uploading',
    options: defaultOptions(),
  };
}

export function newHistoryItem(id: string, sourceJobId: string): CompressItem {
  return {
    ...base,
    id,
    name: 'Archivo del historial',
    sizeBytes: null,
    status: 'analyzing',
    sourceJobId,
    options: defaultOptions(),
  };
}

/**
 * El server analizó el archivo: queda listo. Una grabación de pantalla arranca
 * con su preset (mantiene la resolución para que el texto se lea); lo demás,
 * con «Para compartir». Si ya había opciones elegidas (al recargar), se conservan.
 */
export function withSource(item: CompressItem, source: CompressionSourceResponse): CompressItem {
  // Ya analizado antes (se recargó la página o se volvió a analizar): se conserva lo elegido.
  const keep = item.source !== null;
  const preset = source.job.type === 'recording' ? 'screen' : DEFAULT_PRESET;
  return {
    ...item,
    status: 'ready',
    name: source.job.title ?? item.name,
    sizeBytes: source.job.sizeBytes ?? source.media.sizeBytes ?? item.sizeBytes,
    source,
    options: keep ? item.options : defaultOptions(preset),
    error: null,
  };
}

/** Lo que las cuentas de shared necesitan del original. */
export function toSource(media: CompressionSourceResponse['media']): CompressionSource | null {
  if (!media.hasVideo || media.width === null || media.height === null) return null;
  return {
    width: media.width,
    height: media.height,
    frameRate: media.frameRate,
    durationSeconds: media.durationSeconds,
    hasAudio: media.hasAudio,
    sizeBytes: media.sizeBytes,
  };
}

/** Con qué codifica el server el preset elegido (para el margen y para avisar). */
export const encoderFor = (source: CompressionSourceResponse, options: CompressionOptions) =>
  source.encoders[COMPRESSION_PRESETS[options.preset].codec];

/** Por qué no se puede comprimir así (tamaño objetivo que no alcanza), o null. */
export function itemProblem(item: CompressItem): string | null {
  if (!item.source) return null;
  const source = toSource(item.source.media);
  if (!source) return 'Este archivo no tiene video: no hay nada para comprimir.';
  if (item.options.target.mode !== 'size') return null;
  const fits = (source.sizeBytes ?? Infinity) <= item.options.target.megabytes * BYTES_PER_MB;
  if (fits) return null;
  const plan = planTargetSize(
    source,
    item.options,
    targetMarginFor(encoderFor(item.source, item.options)),
  );
  return plan.ok ? null : targetSizeProblem(plan, item.options.target.megabytes);
}

export const isCompressible = (item: CompressItem) =>
  item.status === 'ready' && item.source !== null && itemProblem(item) === null;

export const isCompressing = (item: CompressItem) =>
  item.status === 'job' && (item.job === null || isActiveStatus(item.job.status));

export type EstimateText = {
  /** «≈ 40 MB a 120 MB», «hasta 24 MB». */
  text: string;
  /** Puede salir igual o más grande que el original (calidad constante). */
  mayNotShrink: boolean;
};

/**
 * Estimación para mostrar antes de comprimir. Con tamaño objetivo es lo
 * pedido; con calidad constante, un rango amplio (depende del contenido: una
 * grabación de pantalla quieta pesa mucho menos que un video con movimiento).
 */
export function estimateText(item: CompressItem): EstimateText | null {
  if (!item.source) return null;
  const source = toSource(item.source.media);
  if (!source) return null;
  const estimate = estimateCompressedSize(source, item.options);
  if (!estimate) return null;
  const original = source.sizeBytes ?? null;
  if (
    item.options.target.mode === 'size' &&
    estimate.maxBytes === item.options.target.megabytes * BYTES_PER_MB
  ) {
    return { text: `hasta ${formatBytes(estimate.maxBytes)}`, mayNotShrink: false };
  }
  // El rango no supera al original: nunca se estima «más grande» que lo que ya hay.
  const max = original !== null ? Math.min(estimate.maxBytes, original) : estimate.maxBytes;
  const min = Math.min(estimate.minBytes, max);
  return {
    text: min === max ? `≈ ${formatBytes(max)}` : `≈ ${formatBytes(min)} a ${formatBytes(max)}`,
    mayNotShrink: original !== null && estimate.maxBytes >= original,
  };
}

/** Alturas a las que se puede bajar, por debajo de lo que ya deja el preset. */
export function heightOptions(item: CompressItem): number[] {
  if (!item.source) return [];
  const source = toSource(item.source.media);
  if (!source) return [];
  const presetHeight = outputVideo(source, { ...item.options, maxHeight: null }).height;
  return COMPRESSION_HEIGHTS.filter((height) => height < presetHeight);
}

/** Etiqueta corta de las opciones: «Para compartir 720p · hasta 24 MB». */
export function optionsTag(options: CompressionOptions): string {
  const parts: string[] = [COMPRESSION_PRESETS[options.preset].label];
  if (options.maxHeight !== null) parts.push(`${String(options.maxHeight)}p`);
  if (options.target.mode === 'size') {
    parts.push(`hasta ${String(options.target.megabytes).replace('.', ',')} MB`);
  }
  return parts.join(' · ');
}

/**
 * «Usar en todos»: copia preset, modo y audio a los demás listos. La altura
 * solo donde baja de verdad (no se sube un archivo más chico).
 */
export function applyOptionsToAll(items: CompressItem[], fromId: string): CompressItem[] {
  const from = items.find((item) => item.id === fromId);
  if (!from) return items;
  return items.map((item) => {
    if (item.id === fromId || item.status !== 'ready' || !item.source) return item;
    const sourceHeight = item.source.media.height ?? 0;
    const maxHeight =
      from.options.maxHeight !== null && from.options.maxHeight < sourceHeight
        ? from.options.maxHeight
        : null;
    return { ...item, options: { ...from.options, maxHeight } };
  });
}

/** Segunda línea de un ítem: «52:18 · 1,4 GB · listo». */
export function itemMeta(item: CompressItem): string {
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

/** Cuánto achicó: «de 419 MB a 107 MB (−74 %)». null si no se sabe. */
export function savingText(
  originalBytes: number | null,
  resultBytes: number | null,
): string | null {
  if (originalBytes === null || resultBytes === null || originalBytes <= 0) return null;
  const change = Math.round((resultBytes / originalBytes - 1) * 100);
  const sign = change < 0 ? '−' : '+';
  return `de ${formatBytes(originalBytes)} a ${formatBytes(resultBytes)} (${sign}${String(Math.abs(change))} %)`;
}

// --- Guardado en sessionStorage (como Convertir) ----------------------------

const storedItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  sizeBytes: z.number().nullable(),
  status: z.enum(['analyzing', 'ready', 'job', 'failed']),
  sourceJobId: z.uuid().nullable(),
  options: compressionOptionsSchema,
  jobId: z.uuid().nullable(),
  error: z.string().nullable(),
  source: compressionSourceResponseSchema.nullable(),
});
const storedBatchSchema = z.array(storedItemSchema);

export function serializeBatch(items: CompressItem[]): string {
  return JSON.stringify(
    items
      .filter((item) => item.status !== 'uploading')
      .map((item) => ({
        id: item.id,
        name: item.name,
        sizeBytes: item.sizeBytes,
        status: item.status,
        sourceJobId: item.sourceJobId,
        options: item.options,
        jobId: item.jobId,
        error: item.error,
        source: item.source,
      })),
  );
}

/** Lo guardado, listo para retomar. Los listos vuelven a analizarse (el archivo pudo expirar). */
export function restoreBatch(raw: string | null): CompressItem[] {
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
