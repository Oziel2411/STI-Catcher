import { isActiveStatus } from '@sti-catcher/shared';
import type { Job } from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import { subscribeToJobEvents } from '../api/events.ts';
import { applyJobEvent } from '../lib/jobs.ts';

/**
 * Sigue un job por SSE. El stream manda primero el estado actual, así que
 * alcanza con el id. Al ver el estado final cierra la suscripción (si no,
 * EventSource reconectaría solo).
 *
 * @param onJobUpdated se llama en cada cambio de estado (no en cada progreso)
 */
export function useTrackedJob(jobId: string | null, onJobUpdated?: (job: Job) => void) {
  const [job, setJob] = useState<Job | null>(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    if (jobId === null) return;
    const close = subscribeToJobEvents(jobId, {
      onEvent: (event) => {
        // Un job nuevo: se descarta el anterior (applyJobEvent ignora ids distintos).
        setJob((current) => applyJobEvent(current?.id === jobId ? current : null, event));
        if (event.type === 'job.updated') {
          onJobUpdated?.(event.job);
          if (!isActiveStatus(event.job.status)) close();
        }
      },
      onConnectionChange: setConnected,
    });
    return close;
  }, [jobId, onJobUpdated]);

  // Mientras llega el primer evento de un job nuevo, no se muestra el anterior.
  return { job: job?.id === jobId ? job : null, connected };
}
