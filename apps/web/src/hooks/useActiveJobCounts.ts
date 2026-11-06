import { activeJobsResponseSchema } from '@sti-catcher/shared';
import type { ActiveJobsResponse } from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import { apiGet } from '../api/client.ts';
import { subscribeToAllEvents } from '../api/events.ts';

/** Espera tras un evento antes de volver a contar (varios cambios juntos = un pedido). */
const REFRESH_DELAY_MS = 400;

const EMPTY: ActiveJobsResponse = { download: 0, conversion: 0, recording: 0 };

/**
 * Trabajos de esta cuenta en cola o en curso, para los contadores de la
 * barra lateral. El server los cuenta (sabe de quién es cada uno por la
 * cookie); acá se vuelve a pedir cada vez que algún trabajo cambia de estado.
 */
export function useActiveJobCounts(): ActiveJobsResponse {
  const [counts, setCounts] = useState<ActiveJobsResponse>(EMPTY);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;

    const refresh = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      apiGet('/api/active-jobs', activeJobsResponseSchema, current.signal)
        .then(setCounts)
        .catch(() => {
          // Sin conexión: quedan los últimos valores; se reintenta con el próximo evento.
        });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_DELAY_MS);
    };

    refresh();
    const unsubscribe = subscribeToAllEvents({
      onEvent: (event) => {
        // El progreso no cambia cuántos hay; solo los cambios de estado y los borrados.
        if (event.type !== 'job.progress') schedule();
      },
      onConnectionChange: (connected) => {
        if (connected) schedule();
      },
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  return counts;
}
