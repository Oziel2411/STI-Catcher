import type { HistoryItem, Job, JobEvent, JobPhase, JobStatus, JobType } from '@sti-catcher/shared';

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
 * Aplica un evento SSE a la lista del historial. Conserva `isMine` (los
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
    return updated === item ? item : { ...updated, isMine: item.isMine };
  });
  return next.some((item, index) => item !== items[index]) ? next : items;
}
