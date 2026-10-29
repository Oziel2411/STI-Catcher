import { healthResponseSchema } from '@sti-catcher/shared';
import type { HealthResponse } from '@sti-catcher/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../../api/client.ts';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: HealthResponse };

/** Estado del server. `refresh()` fuerza a volver a consultar las versiones. */
export function useHealth() {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });
  const [isRefreshing, setIsRefreshing] = useState(true);
  const controllerRef = useRef<AbortController | null>(null);

  // Lanza la consulta. El estado se actualiza solo cuando llega la respuesta;
  // si sale otra consulta antes, la anterior se cancela y se ignora.
  const fetchHealth = useCallback((force: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    apiGet(`/api/health${force ? '?refresh=1' : ''}`, healthResponseSchema, controller.signal)
      .then(
        (data) => {
          setState({ kind: 'ready', data });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Error desconocido.',
          });
        },
      )
      .finally(() => {
        if (controllerRef.current === controller) setIsRefreshing(false);
      });
  }, []);

  useEffect(() => {
    fetchHealth(false);
    return () => controllerRef.current?.abort();
  }, [fetchHealth]);

  /** Vuelve a consultar las versiones de las herramientas (tarda unos segundos). */
  const refresh = useCallback(() => {
    setIsRefreshing(true);
    fetchHealth(true);
  }, [fetchHealth]);

  /** Actualiza disco y trabajos; las versiones salen de la caché del server. */
  const reload = useCallback(() => {
    fetchHealth(false);
  }, [fetchHealth]);

  return { state, isRefreshing, refresh, reload };
}
