import type { Job } from '@sti-catcher/shared';
import type { ReactNode } from 'react';
import { progressDetails, STATUS_LABELS } from '../lib/jobs.ts';

type Props = {
  job: Job;
  connected: boolean;
  /** Qué mostrar cuando el job terminó bien. */
  doneContent: ReactNode;
};

/** Estado y progreso de un job: barra, fase, porcentaje, velocidad y tiempo restante. */
export function JobProgress({ job, connected, doneContent }: Props) {
  const progress = job.progress;
  const percent = progress?.percent ?? null;
  const statusClass =
    job.status === 'done' ? 'badge-ok' : job.status === 'failed' ? 'badge-error' : 'badge-muted';

  const details = progressDetails(progress);

  return (
    <div className="job" aria-live="polite">
      <div className="job-header">
        <span className={`badge ${statusClass}`}>{STATUS_LABELS[job.status]}</span>
        <span className="muted small">{job.title}</span>
      </div>

      {job.status === 'running' && (
        <>
          <div
            className={`meter ${percent === null ? 'meter-indeterminate' : ''}`}
            role="progressbar"
            aria-label="Progreso"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent !== null ? { 'aria-valuenow': Math.round(percent) } : {})}
          >
            <div
              className="meter-fill"
              style={percent !== null ? { width: `${String(percent)}%` } : undefined}
            />
          </div>
          <p className="small">{details.join(' · ')}</p>
          {!connected && (
            <p className="small text-warn">Se perdió la conexión con el servidor. Reintentando…</p>
          )}
        </>
      )}

      {job.status === 'queued' && (
        <p className="small muted">En cola: esperando a que terminen otros trabajos.</p>
      )}
      {job.status === 'done' && doneContent}
      {job.status === 'cancelled' && (
        <p className="small">
          Cancelado: el proceso se detuvo y se borraron los archivos parciales.
        </p>
      )}
      {job.status === 'failed' && job.error && <p className="small text-error">{job.error}</p>}
    </div>
  );
}
