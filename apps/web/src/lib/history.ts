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
  openOriginal: boolean;
  retry: boolean;
  cancel: boolean;
  remove: boolean;
};

/** Qué se puede hacer con un trabajo del historial. */
export function historyActions(item: HistoryItem): HistoryActions {
  const active = isActiveStatus(item.status);
  const hasFile = item.status === 'done';
  return {
    play: hasFile,
    download: hasFile,
    convert: hasFile,
    openOriginal: item.sourceUrl !== null,
    retry:
      (item.status === 'failed' || item.status === 'cancelled') &&
      (item.type === 'download' || item.type === 'conversion'),
    cancel: active && item.isMine,
    remove: !active && item.isMine,
  };
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
