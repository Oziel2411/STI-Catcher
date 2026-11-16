import {
  compressionSourceResponseSchema,
  createJobResponseSchema,
  jobResponseSchema,
} from '@sti-catcher/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';
import { subscribeToJobsEvents } from '../../api/events.ts';
import { withNoticeBatch } from '../../api/notice-batch.ts';
import { createUploadQueue, newLocalId } from '../../api/upload-queue.ts';
import {
  applyOptionsToAll,
  isCompressible,
  isCompressing,
  newHistoryItem,
  newUploadItem,
  restoreBatch,
  serializeBatch,
  withSource,
} from '../../lib/compress-batch.ts';
import type { CompressItem } from '../../lib/compress-batch.ts';
import { applyEventToItems } from '../../lib/convert-batch.ts';
import { formatBytes } from '../../lib/format.ts';

const STORAGE_KEY = 'sti.compress.batch';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

function readStored(): CompressItem[] {
  try {
    return restoreBatch(sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

/**
 * Lista de videos para comprimir (D-108), con la misma mecánica que Convertir
 * (D-092): sube de a uno, analiza cada archivo en el server, crea las
 * compresiones y las sigue por SSE. La lista vive en sessionStorage.
 */
export function useCompressBatch(maxUploadBytes: number | null) {
  const [items, setItems] = useState<CompressItem[]>(readStored);
  const [selectedId, setSelectedId] = useState<string | null>(() => items[0]?.id ?? null);
  const [notices, setNotices] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const analyzing = useRef(new Set<string>());

  const update = useCallback((id: string, patch: Partial<CompressItem>) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);
  const [uploads] = useState(() =>
    createUploadQueue({
      onProgress: (id, loadedBytes) => {
        update(id, { uploadedBytes: loadedBytes });
      },
      onUploaded: (id, jobId, sizeBytes) => {
        update(id, { status: 'analyzing', sourceJobId: jobId, uploadedBytes: sizeBytes });
      },
      onFailed: (id, message) => {
        update(id, { status: 'failed', error: message });
      },
    }),
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, serializeBatch(items));
    } catch {
      // Sin sessionStorage (modo privado, cuota): la lista solo vive en esta pestaña.
    }
  }, [items]);

  // Analizar lo que llegó (subido o del historial).
  useEffect(() => {
    for (const item of items) {
      if (item.status !== 'analyzing' || !item.sourceJobId || analyzing.current.has(item.id)) {
        continue;
      }
      analyzing.current.add(item.id);
      const { id, sourceJobId } = item;
      apiGet(
        `/api/compression/sources/${encodeURIComponent(sourceJobId)}`,
        compressionSourceResponseSchema,
      )
        .then((source) => {
          setItems((list) =>
            list.map((entry) => (entry.id === id ? withSource(entry, source) : entry)),
          );
        })
        .catch((error: unknown) => {
          update(id, { status: 'failed', error: errorMessage(error) });
        })
        .finally(() => {
          analyzing.current.delete(id);
        });
    }
  }, [items, update]);

  const activeJobIds = useMemo(
    () =>
      items
        .filter((item) => item.jobId !== null && isCompressing(item))
        .map((item) => item.jobId as string)
        .sort()
        .join(','),
    [items],
  );
  useEffect(() => {
    if (activeJobIds === '') return;
    return subscribeToJobsEvents(activeJobIds.split(','), {
      onEvent: (event) => {
        setItems((list) => applyEventToItems(list, event));
      },
    });
  }, [activeJobIds]);

  useEffect(
    () => () => {
      uploads.abortAll();
    },
    [uploads],
  );

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      if (maxUploadBytes === null) return;
      const skipped: string[] = [];
      const added: { item: CompressItem; file: File }[] = [];
      for (const file of Array.from(list)) {
        if (file.size > maxUploadBytes) {
          skipped.push(
            `«${file.name}» pesa ${formatBytes(file.size)} y el máximo es ${formatBytes(maxUploadBytes)}: no se agregó.`,
          );
          continue;
        }
        added.push({ item: newUploadItem(newLocalId(), file), file });
      }
      setNotices(skipped);
      if (added.length === 0) return;
      setItems((current) => [...current, ...added.map((entry) => entry.item)]);
      setSelectedId((selected) => selected ?? added[0]?.item.id ?? null);
      for (const { item, file } of added) uploads.add(item.id, file);
    },
    [maxUploadBytes, uploads],
  );

  /** Archivos del historial (`?origen=`): los que ya están en la lista no se repiten. */
  // Los ids se arman afuera del updater: React lo puede correr dos veces (modo estricto).
  const addFromHistory = useCallback(
    (jobIds: string[]) => {
      const present = new Set(items.map((item) => item.sourceJobId));
      const added = jobIds
        .filter((jobId) => !present.has(jobId))
        .map((jobId) => newHistoryItem(newLocalId(), jobId));
      const first = added[0];
      if (!first) return;
      setItems((list) => [...list, ...added]);
      setSelectedId(first.id);
    },
    [items],
  );

  const remove = (id: string) => {
    uploads.remove(id);
    const index = items.findIndex((item) => item.id === id);
    const next = items.filter((item) => item.id !== id);
    setItems((list) => list.filter((item) => item.id !== id));
    if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
  };

  const applyToAll = useCallback((id: string) => {
    setItems((list) => applyOptionsToAll(list, id));
  }, []);

  const compressible = items.filter(isCompressible);

  /** Crea una compresión por cada archivo listo. El server corre una a la vez. */
  const compressReady = async (notify: string[] = []) => {
    setSubmitting(true);
    const targets = items.filter((entry) => isCompressible(entry) && entry.sourceJobId);
    await withNoticeBatch(notify, targets.length, async (batchId) => {
      for (const item of targets) {
        if (!item.sourceJobId) continue;
        try {
          const { jobId } = await apiPost('/api/jobs/compress', createJobResponseSchema, {
            sourceJobId: item.sourceJobId,
            ...item.options,
            notify,
            batchId,
          });
          update(item.id, { status: 'job', jobId, job: null, error: null });
        } catch (error) {
          update(item.id, { error: errorMessage(error) });
        }
      }
    });
    setSubmitting(false);
  };

  const cancel = (item: CompressItem) => {
    if (!item.jobId) return;
    apiPost(`/api/jobs/${item.jobId}/cancel`, jobResponseSchema).catch((error: unknown) => {
      update(item.id, { error: errorMessage(error) });
    });
  };

  const retry = (item: CompressItem) => {
    if (!item.jobId) return;
    apiPost(`/api/jobs/${item.jobId}/retry`, createJobResponseSchema)
      .then(({ jobId }) => {
        update(item.id, { jobId, job: null, error: null });
      })
      .catch((error: unknown) => {
        update(item.id, { error: errorMessage(error) });
      });
  };

  /** Volver a elegir opciones (otra compresión del mismo archivo). */
  const compressAgain = (item: CompressItem) => {
    update(item.id, {
      status: item.source ? 'ready' : 'analyzing',
      jobId: null,
      job: null,
      error: null,
    });
  };

  const reanalyze = (item: CompressItem) => {
    if (item.sourceJobId) update(item.id, { status: 'analyzing', error: null });
  };

  const uploading = items.some((item) => item.status === 'uploading');
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [uploading]);

  return {
    items,
    selected: items.find((item) => item.id === selectedId) ?? null,
    select: setSelectedId,
    notices,
    dismissNotices: () => {
      setNotices([]);
    },
    submitting,
    compressibleCount: compressible.length,
    addFiles,
    addFromHistory,
    remove,
    update,
    applyToAll,
    compressReady,
    cancel,
    retry,
    compressAgain,
    reanalyze,
  };
}

export type CompressBatch = ReturnType<typeof useCompressBatch>;
