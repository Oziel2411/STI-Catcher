import type {
  HistoryItem,
  Job,
  JobEvent,
  JobPhase,
  JobProgress,
  JobStatus,
  JobType,
} from '@sti-catcher/shared';
import { formatBytes, formatEta, formatSpeedRatio } from './format.ts';

/** Partes de la línea de progreso: fase, porcentaje, velocidad y tiempo restante. */
export function progressDetails(progress: JobProgress | null): string[] {
  const details: string[] = [progress ? PHASE_LABELS[progress.phase] : 'Iniciando'];
  if (progress?.percent != null) details.push(`${progress.percent.toFixed(0)} %`);
  if (progress?.speedBytesPerSecond != null && progress.speedBytesPerSecond > 0) {
    details.push(`${formatBytes(progress.speedBytesPerSecond)}/s`);
  }
  // En los primeros segundos ffmpeg todavía no avanzó: "0x" confunde más de lo que informa.
  if (progress?.speedRatio != null && progress.speedRatio > 0) {
    details.push(`velocidad ${formatSpeedRatio(progress.speedRatio)}`);
  }
  if (progress?.etaSeconds != null) details.push(`faltan ${formatEta(progress.etaSeconds)}`);
  return details;
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'En cola',
  running: 'En curso',
  done: 'Terminado',
  failed: 'Falló',
  cancelled: 'Cancelado',
  expired: 'Expirado',
};

export const PHASE_LABELS: Record<JobPhase, string> = {
  downloading: 'Descargando',
  merging: 'Uniendo audio y video',
  converting: 'Convirtiendo',
  processing: 'Procesando',
};

export const TYPE_LABELS: Record<JobType, string> = {
  download: 'Descarga',
  upload: 'Archivo subido',
  conversion: 'Conversión',
  recording: 'Grabación',
  selftest: 'Prueba del sistema',
};

/**
 * Aplica un evento SSE al estado local de un job. Función pura: devuelve el
 * mismo objeto si el evento no corresponde a ese job. `job.deleted` no cambia
 * un job individual (lo maneja la lista: ver applyEventToList).
 */
export function applyJobEvent(job: Job, event: JobEvent): Job;
export function applyJobEvent(job: Job | null, event: JobEvent): Job | null;
export function applyJobEvent(job: Job | null, event: JobEvent): Job | null {
  if (event.type === 'job.updated') {
    return job === null || event.job.id === job.id ? event.job : job;
  }
  if (event.type === 'job.deleted') return job;
  if (job === null || event.jobId !== job.id || job.status !== 'running') return job;
  return { ...job, progress: event.progress };
}

/**
 * Aplica un evento SSE a la lista del historial. Conserva `isMine` y `parentTitle` (los
 * eventos no lo traen: depende de quién mira) y quita los borrados.
 * Devuelve la misma lista si nada cambió, para no re-renderizar.
 */
export function applyEventToList(items: HistoryItem[], event: JobEvent): HistoryItem[] {
  if (event.type === 'job.deleted') {
    return items.some((item) => item.id === event.jobId)
      ? items.filter((item) => item.id !== event.jobId)
      : items;
  }
  const next = items.map((item) => {
    const updated = applyJobEvent(item, event);
    return updated === item
      ? item
      : { ...updated, isMine: item.isMine, parentTitle: item.parentTitle };
  });
  return next.some((item, index) => item !== items[index]) ? next : items;
}
