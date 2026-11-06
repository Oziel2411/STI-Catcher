import {
  createJobResponseSchema,
  jobResponseSchema,
  probeResponseSchema,
} from '@sti-catcher/shared';
import type { ConversionPresetId, GifLimits } from '@sti-catcher/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError, apiPost } from '../../api/client.ts';
import { subscribeToJobsEvents } from '../../api/events.ts';
import {
  activeJob,
  applyEventToItems,
  applyPresetToChecked,
  downloadRequest,
  newLinkItem,
  parseLinks,
  restoreLinks,
  serializeLinks,
  startTargets,
  trackedJobIds,
  withProbe,
} from '../../lib/download-batch.ts';
import type { DownloadItem, ParsedLinks } from '../../lib/download-batch.ts';

const STORAGE_KEY = 'sti.download.batch';
/** Análisis simultáneos (el server acepta 4 y otra pestaña puede estar usando alguno). */
const MAX_PROBES = 3;
/** Espera antes de reintentar un análisis que el server rechazó por ocupado (429). */
const BUSY_RETRY_MS = 2500;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

// crypto.randomUUID solo existe en contexto seguro (ver useConvertBatch).
let counter = 0;
const newLocalId = () => `link-${Date.now().toString(36)}-${String(++counter)}`;

function readStored(): DownloadItem[] {
  try {
    return restoreLinks(sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

/**
 * Lista de links de Descargar (mockup 2a): analiza cada uno (de a tres),
 * guarda el formato elegido por fila, crea las descargas y las sigue por SSE,
 * incluida la conversión encadenada. Se guarda en sessionStorage.
 */
export function useDownloadBatch(limits: GifLimits | null) {
  const [items, setItems] = useState<DownloadItem[]>(readStored);
  const [submitting, setSubmitting] = useState(false);
  const probing = useRef(new Set<string>());
  const [retryTick, setRetryTick] = useState(0);

  const update = useCallback((id: string, patch: Partial<DownloadItem>) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, serializeLinks(items));
    } catch {
      // Sin sessionStorage: la lista solo vive en esta pestaña.
    }
  }, [items]);

  // Analizar los pendientes, de a MAX_PROBES.
  useEffect(() => {
    if (!limits) return;
    for (const item of items) {
      if (probing.current.size >= MAX_PROBES) break;
      if (item.status !== 'analyzing' || probing.current.has(item.id)) continue;
      probing.current.add(item.id);
      const { id, url } = item;
      apiPost('/api/media/probe', probeResponseSchema, { url })
        .then((probe) => {
          setItems((list) =>
            list.map((entry) => (entry.id === id ? withProbe(entry, probe, limits) : entry)),
          );
        })
        .catch((error: unknown) => {
          if (error instanceof ApiClientError && error.status === 429) {
            // Ocupado: sigue en analyzing y se vuelve a intentar.
            setTimeout(() => {
              setRetryTick((tick) => tick + 1);
            }, BUSY_RETRY_MS);
            return;
          }
          update(id, { status: 'failed', error: errorMessage(error), checked: false });
        })
        .finally(() => {
          probing.current.delete(id);
          setRetryTick((tick) => tick + 1);
        });
    }
  }, [items, limits, update, retryTick]);

  // Seguir por SSE descargas y conversiones (el server manda primero su estado actual).
  const tracked = useMemo(() => trackedJobIds(items).join(','), [items]);
  useEffect(() => {
    if (tracked === '') return;
    return subscribeToJobsEvents(tracked.split(','), {
      onEvent: (event) => {
        setItems((list) => applyEventToItems(list, event));
      },
    });
  }, [tracked]);

  /** Agrega los links pegados. Devuelve qué se agregó y qué no. */
  const addLinks = (text: string): ParsedLinks => {
    const parsed = parseLinks(
      text,
      items.map((item) => item.url),
    );
    if (parsed.urls.length > 0) {
      const added = parsed.urls.map((url) => newLinkItem(newLocalId(), url));
      setItems((list) => [...list, ...added]);
    }
    return parsed;
  };

  const remove = (id: string) => {
    setItems((list) => list.filter((item) => item.id !== id));
  };

  const setChecked = (id: string, checked: boolean) => {
    update(id, { checked });
  };

  const setAllChecked = (checked: boolean) => {
    setItems((list) =>
      list.map((item) =>
        item.status === 'ready' || item.status === 'analyzing' ? { ...item, checked } : item,
      ),
    );
  };

  const applyToChecked = (preset: ConversionPresetId) => {
    setItems((list) => applyPresetToChecked(list, preset));
  };

  /** Crea una descarga por cada fila lista (la cola del server limita cuántas corren). */
  const startReady = async (notify: string[] = []) => {
    if (!limits) return;
    setSubmitting(true);
    for (const item of startTargets(items, limits)) {
      const request = downloadRequest(item);
      if (!request) continue;
      try {
        const { jobId } = await apiPost('/api/jobs/download', createJobResponseSchema, {
          ...request,
          notify,
        });
        update(item.id, { status: 'job', jobId, job: null, followUp: null, checked: false });
      } catch (error) {
        update(item.id, { error: errorMessage(error) });
      }
    }
    setSubmitting(false);
  };

  /** Cancela lo que esté en curso: la descarga o, si ya bajó, la conversión. */
  const cancel = (item: DownloadItem) => {
    const job = activeJob(item);
    const id = job?.id ?? (item.job === null ? item.jobId : null);
    if (!id) return;
    apiPost(`/api/jobs/${id}/cancel`, jobResponseSchema).catch((error: unknown) => {
      update(item.id, { error: errorMessage(error) });
    });
  };

  /**
   * Reintentar: un análisis fallido se vuelve a hacer; una conversión
   * fallida se reintenta sola (el video ya está bajado); una descarga
   * fallida crea una nueva, que vuelve a encadenar la conversión.
   */
  const retry = (item: DownloadItem) => {
    if (item.status === 'failed') {
      update(item.id, { status: 'analyzing', error: null, probe: null });
      return;
    }
    const failedFollowUp =
      item.followUp && !['queued', 'running', 'done'].includes(item.followUp.status)
        ? item.followUp
        : null;
    if (failedFollowUp) {
      apiPost(`/api/jobs/${failedFollowUp.id}/retry`, createJobResponseSchema)
        .then(({ jobId }) => {
          // La nueva conversión no queda vinculada a la descarga: se sigue como si lo fuera.
          setItems((list) =>
            list.map((entry) =>
              entry.id === item.id && entry.job
                ? {
                    ...entry,
                    job: { ...entry.job, followUpJobId: jobId },
                    followUp: null,
                    error: null,
                  }
                : entry,
            ),
          );
        })
        .catch((error: unknown) => {
          update(item.id, { error: errorMessage(error) });
        });
      return;
    }
    if (!item.jobId) return;
    apiPost(`/api/jobs/${item.jobId}/retry`, createJobResponseSchema)
      .then(({ jobId }) => {
        update(item.id, { jobId, job: null, followUp: null, error: null });
      })
      .catch((error: unknown) => {
        update(item.id, { error: errorMessage(error) });
      });
  };

  return {
    items,
    submitting,
    addLinks,
    remove,
    update,
    setChecked,
    setAllChecked,
    applyToChecked,
    startReady,
    cancel,
    retry,
  };
}

export type DownloadBatch = ReturnType<typeof useDownloadBatch>;
