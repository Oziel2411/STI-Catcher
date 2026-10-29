import type { Job, JobEvent, JobPhase, JobStatus } from '@sti-catcher/shared';

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

/**
 * Aplica un evento SSE al estado local de un job. Función pura: devuelve el
 * mismo objeto si el evento no corresponde a ese job.
 */
export function applyJobEvent(job: Job | null, event: JobEvent): Job | null {
  if (event.type === 'job.updated') {
    return job === null || event.job.id === job.id ? event.job : job;
  }
  if (job === null || event.jobId !== job.id || job.status !== 'running') return job;
  return { ...job, progress: event.progress };
}
