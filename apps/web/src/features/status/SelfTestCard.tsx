import {
  createJobResponseSchema,
  isActiveStatus,
  jobResponseSchema,
  listJobsResponseSchema,
} from '@sti-catcher/shared';
import type { Job } from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';
import { subscribeToJobEvents } from '../../api/events.ts';
import { formatBytes, formatEta, formatSpeedRatio } from '../../lib/format.ts';
import { applyJobEvent, PHASE_LABELS, STATUS_LABELS } from '../../lib/jobs.ts';

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
  const [job, setJob] = useState<Job | null>(null);
  const [duration, setDuration] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);

  // Si ya hay una prueba en curso (otra pestaña, o se recargó la página), se retoma.
  useEffect(() => {
    const controller = new AbortController();
    apiGet(
      '/api/jobs?type=selftest&status=queued,running&limit=1',
      listJobsResponseSchema,
      controller.signal,
    )
      .then(({ jobs }) => {
        const active = jobs[0];
        if (active) {
          setJob(active);
          setTrackedId(active.id);
        }
      })
      .catch(() => {
        // Sin esto la tarjeta igual funciona: se puede lanzar una prueba nueva.
      });
    return () => {
      controller.abort();
    };
  }, []);

  // Progreso en vivo. El stream manda primero el estado actual del job.
  useEffect(() => {
    if (trackedId === null) return;
    const close = subscribeToJobEvents(trackedId, {
      onEvent: (event) => {
        setJob((current) => applyJobEvent(current ?? null, event));
        if (event.type === 'job.updated') {
          onJobUpdated();
          // El server cierra el stream al terminar; cerrarlo acá evita que EventSource reconecte.
          if (!isActiveStatus(event.job.status)) close();
        }
      },
      onConnectionChange: setConnected,
    });
    return close;
  }, [trackedId, onJobUpdated]);

  const isActive = job !== null && isActiveStatus(job.status);

  const start = () => {
    setBusy(true);
    setError(null);
    apiPost('/api/jobs/selftest', createJobResponseSchema, { durationSeconds: duration })
      .then(({ jobId }) => {
        setJob(null);
        setConnected(true);
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
      {job && <JobProgressView job={job} connected={connected} />}
    </div>
  );
}

function JobProgressView({ job, connected }: { job: Job; connected: boolean }) {
  const progress = job.progress;
  const percent = progress?.percent ?? null;
  const statusClass =
    job.status === 'done' ? 'badge-ok' : job.status === 'failed' ? 'badge-error' : 'badge-muted';

  return (
    <div className="job" aria-live="polite">
      <div className="job-header">
        <span className={`badge ${statusClass}`}>{STATUS_LABELS[job.status]}</span>
        <span className="muted small">{job.title}</span>
      </div>

      {job.status === 'running' && (
        <>
          <div
            className="meter"
            role="progressbar"
            aria-label="Progreso"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent !== null ? { 'aria-valuenow': Math.round(percent) } : {})}
          >
            <div className="meter-fill" style={{ width: `${String(percent ?? 0)}%` }} />
          </div>
          <p className="small">
            {progress ? PHASE_LABELS[progress.phase] : 'Iniciando'}
            {percent !== null && ` · ${percent.toFixed(0)} %`}
            {/* En los primeros segundos ffmpeg todavía no avanzó: "0x" confunde más de lo que informa. */}
            {progress?.speedRatio != null &&
              progress.speedRatio > 0 &&
              ` · velocidad ${formatSpeedRatio(progress.speedRatio)}`}
            {progress?.etaSeconds != null && ` · faltan ${formatEta(progress.etaSeconds)}`}
          </p>
          {!connected && (
            <p className="small text-warn">Se perdió la conexión con el servidor. Reintentando…</p>
          )}
        </>
      )}

      {job.status === 'queued' && (
        <p className="small muted">Esperando a que termine otro trabajo.</p>
      )}
      {job.status === 'done' && (
        <p className="small">
          Funciona: se generó un video de {formatBytes(job.sizeBytes ?? 0)} y se borró al terminar.
        </p>
      )}
      {job.status === 'cancelled' && (
        <p className="small">
          Cancelado: el proceso se detuvo y se borraron los archivos parciales.
        </p>
      )}
      {job.status === 'failed' && job.error && <p className="small text-error">{job.error}</p>}
    </div>
  );
}
