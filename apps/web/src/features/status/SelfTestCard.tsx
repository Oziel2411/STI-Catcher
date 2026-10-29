import {
  createJobResponseSchema,
  isActiveStatus,
  jobResponseSchema,
  listJobsResponseSchema,
} from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';
import { JobProgress } from '../../components/JobProgress.tsx';
import { useTrackedJob } from '../../hooks/useTrackedJob.ts';
import { formatBytes } from '../../lib/format.ts';

const DURATIONS = [10, 60, 120] as const;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

/**
 * "Probar sistema": lanza un job `selftest` (ffmpeg genera un video de prueba
 * a velocidad real) y muestra su progreso en vivo por SSE, con opción de cancelar.
 * Sirve para verificar una instalación sin depender de internet.
 */
export function SelfTestCard({ onJobUpdated }: { onJobUpdated: () => void }) {
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job, connected } = useTrackedJob(trackedId, onJobUpdated);

  // Si ya hay una prueba en curso (otra pestaña, o se recargó la página), se retoma.
  useEffect(() => {
    const controller = new AbortController();
    apiGet(
      '/api/jobs?type=selftest&status=queued,running&limit=1',
      listJobsResponseSchema,
      controller.signal,
    )
      .then(({ jobs }) => {
        if (jobs[0]) setTrackedId(jobs[0].id);
      })
      .catch(() => {
        // Sin esto la tarjeta igual funciona: se puede lanzar una prueba nueva.
      });
    return () => {
      controller.abort();
    };
  }, []);

  const isActive = job !== null && isActiveStatus(job.status);

  const start = () => {
    setBusy(true);
    setError(null);
    apiPost('/api/jobs/selftest', createJobResponseSchema, { durationSeconds: duration })
      .then(({ jobId }) => {
        setTrackedId(jobId);
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const cancel = () => {
    if (!job) return;
    setBusy(true);
    setError(null);
    // El estado final ("Cancelado") llega por SSE cuando el proceso ya terminó.
    apiPost(`/api/jobs/${job.id}/cancel`, jobResponseSchema)
      .catch((e: unknown) => {
        setError(errorMessage(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="card">
      <h2>Probar sistema</h2>
      <p className="muted small">
        Genera un video de prueba con ffmpeg, en tiempo real, sin usar internet. Sirve para
        verificar que la cola de trabajos, el progreso en vivo y la cancelación funcionan en este
        servidor.
      </p>

      <div className="row">
        <label className="field">
          <span>Duración</span>
          <select
            value={duration}
            onChange={(e) => {
              setDuration(Number(e.target.value));
            }}
            disabled={isActive || busy}
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} segundos
              </option>
            ))}
          </select>
        </label>
        {isActive ? (
          <button type="button" className="button button-danger" onClick={cancel} disabled={busy}>
            Cancelar
          </button>
        ) : (
          <button type="button" className="button" onClick={start} disabled={busy}>
            Iniciar prueba
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {trackedId !== null && job === null && <p className="muted small">Conectando…</p>}
      {job && (
        <JobProgress
          job={job}
          connected={connected}
          doneContent={
            <p className="small">
              Funciona: se generó un video de {formatBytes(job.sizeBytes ?? 0)} y se borró al
              terminar.
            </p>
          }
        />
      )}
    </div>
  );
}
