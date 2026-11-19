import { isActiveStatus } from '@sti-catcher/shared';
import type { HistoryItem, JobEvent } from '@sti-catcher/shared';
import { formatDuration } from './format.ts';

/** Solo audio: se reproduce con <audio> y se muestra con otro ícono. */
export const isAudioOnly = (item: HistoryItem): boolean =>
  item.format === 'mp3' ||
  item.format === 'm4a' ||
  item.format === 'wav' ||
  (item.resolution === null && item.audioCodec !== null);

/** Un GIF no se reproduce con <video>: se muestra como imagen. */
export const isImage = (item: HistoryItem): boolean => item.format === 'gif';

/** Columna «Archivo»: formato, resolución y duración del archivo final. */
export function fileDetails(item: HistoryItem): string {
  const parts = [
    item.format?.toUpperCase() ?? null,
    item.resolution,
    item.durationSeconds !== null ? formatDuration(item.durationSeconds) : null,
  ].filter((part): part is string => part !== null && part !== '' && part !== '—');
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** El sitio de un link, sin «www.» (para la descripción de una descarga). */
export function siteName(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export type HistoryActions = {
  play: boolean;
  download: boolean;
  convert: boolean;
  /** Achicar un video (D-108): no para audio ni GIF. */
  compress: boolean;
  openOriginal: boolean;
  retry: boolean;
  cancel: boolean;
  /** Borrar el trabajo y el archivo; también decide si la fila se puede elegir (D-113). */
  remove: boolean;
  /** Borrar solo el archivo: la fila queda como «archivo borrado» (D-113). */
  removeFile: boolean;
  /** Cambiar el título (D-113). */
  rename: boolean;
};

/** Qué se puede hacer con un trabajo del historial. */
export function historyActions(item: HistoryItem): HistoryActions {
  const active = isActiveStatus(item.status);
  const hasFile = item.status === 'done';
  return {
    play: hasFile,
    download: hasFile,
    convert: hasFile,
    compress: hasFile && !isAudioOnly(item) && !isImage(item),
    openOriginal: item.sourceUrl !== null,
    retry:
      (item.status === 'failed' || item.status === 'cancelled') &&
      (item.type === 'download' || item.type === 'conversion' || item.type === 'compression'),
    cancel: active && item.isMine,
    remove: !active && item.isMine,
    removeFile: hasFile && item.isMine,
    rename: !active && item.isMine,
  };
}

/** Lo elegido para borrar de a varios: cuántos, cuántos tienen archivo y cuánto ocupan. */
export type SelectionSummary = {
  ids: string[];
  withFile: string[];
  bytes: number;
};

export function selectionSummary(
  items: readonly HistoryItem[],
  selected: ReadonlySet<string>,
): SelectionSummary {
  const chosen = items.filter((item) => selected.has(item.id) && historyActions(item).remove);
  const withFile = chosen.filter((item) => historyActions(item).removeFile);
  return {
    ids: chosen.map((item) => item.id),
    withFile: withFile.map((item) => item.id),
    bytes: withFile.reduce((total, item) => total + (item.sizeBytes ?? 0), 0),
  };
}

/**
 * Deja en la selección solo las filas que siguen en la lista y se pueden
 * borrar (al cambiar de página, al borrarse, al empezar de nuevo). Devuelve el
 * mismo Set si no cambió nada, para no volver a dibujar.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  items: readonly HistoryItem[],
): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const valid = new Set(
    items.filter((item) => selected.has(item.id) && historyActions(item).remove).map((i) => i.id),
  );
  return valid.size === selected.size ? selected : valid;
}

/**
 * Un evento de un trabajo que no está en la lista y es más nuevo que todos los
 * que se ven: hay que volver a pedir la primera página para que aparezca.
 * La prueba del sistema no va al historial.
 */
export function isNewJobEvent(event: JobEvent, items: readonly HistoryItem[]): boolean {
  if (event.type !== 'job.updated') return false;
  const { job } = event;
  if (job.type === 'selftest') return false;
  if (items.some((item) => item.id === job.id)) return false;
  return items.every((item) => job.createdAt > item.createdAt);
}
