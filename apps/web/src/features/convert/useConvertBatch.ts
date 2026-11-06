import {
  conversionSourceResponseSchema,
  createJobResponseSchema,
  jobResponseSchema,
} from '@sti-catcher/shared';
import type { ConversionOptionsResponse } from '@sti-catcher/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError, apiGet, apiPost } from '../../api/client.ts';
import { subscribeToJobsEvents } from '../../api/events.ts';
import { uploadFile } from '../../api/upload.ts';
import type { UploadHandle } from '../../api/upload.ts';
import {
  applyEventToItems,
  applyFormatToAll,
  isConverting,
  isConvertible,
  newHistoryItem,
  newUploadItem,
  restoreBatch,
  serializeBatch,
  withSource,
} from '../../lib/convert-batch.ts';
import type { ConvertItem } from '../../lib/convert-batch.ts';
import { formatBytes } from '../../lib/format.ts';

const STORAGE_KEY = 'sti.convert.batch';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

// crypto.randomUUID solo existe en contexto seguro, y Convertir también se usa por http://<IP>.
let counter = 0;
const newLocalId = () => `item-${Date.now().toString(36)}-${String(++counter)}`;

type UploadQueue = {
  files: { current: Map<string, File> };
  queue: { current: string[] };
  current: { current: { id: string; handle: UploadHandle } | null };
  update: (id: string, patch: Partial<ConvertItem>) => void;
};

/** Sube el siguiente de la cola, de a uno; al terminar sigue con el próximo. */
function pumpUploads(ctx: UploadQueue): void {
  if (ctx.current.current) return;
  let id = ctx.queue.current.shift();
  while (id !== undefined && !ctx.files.current.has(id)) id = ctx.queue.current.shift();
  const file = id === undefined ? undefined : ctx.files.current.get(id);
  if (id === undefined || !file) return;
  const itemId = id;
  const handle = uploadFile(file, (progress) => {
    ctx.update(itemId, { uploadedBytes: progress.loadedBytes });
  });
  ctx.current.current = { id: itemId, handle };
  handle.promise
    .then(({ jobId }) => {
      ctx.update(itemId, { status: 'analyzing', sourceJobId: jobId, uploadedBytes: file.size });
    })
    .catch((error: unknown) => {
      // Cancelada a propósito: el ítem ya se quitó de la lista.
      if (error instanceof ApiClientError && error.code === 'ABORTED') return;
      ctx.update(itemId, { status: 'failed', error: errorMessage(error) });
    })
    .finally(() => {
      ctx.files.current.delete(itemId);
      ctx.current.current = null;
      pumpUploads(ctx);
    });
}

function readStored(): ConvertItem[] {
  try {
    return restoreBatch(sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

/**
 * Lista de archivos para convertir (mockup 2e). Sube de a uno (cada subida
 * respeta el máximo del server), analiza cada archivo para saber qué formatos
 * tienen sentido, crea las conversiones y las sigue por SSE. La lista se
 * guarda en sessionStorage: recargar la página no la pierde.
 */
export function useConvertBatch(options: ConversionOptionsResponse | null) {
  const [items, setItems] = useState<ConvertItem[]>(readStored);
  const [selectedId, setSelectedId] = useState<string | null>(() => items[0]?.id ?? null);
  const [notices, setNotices] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const files = useRef(new Map<string, File>());
  const queue = useRef<string[]>([]);
  const current = useRef<{ id: string; handle: UploadHandle } | null>(null);
  const analyzing = useRef(new Set<string>());

  const update = useCallback((id: string, patch: Partial<ConvertItem>) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  // Guardar la lista (sin los File).
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, serializeBatch(items));
    } catch {
      // Sin sessionStorage (modo privado, cuota): la lista solo vive en esta pestaña.
    }
  }, [items]);

  // Analizar lo que llegó (subido o del historial) para saber qué formatos ofrecer.
  useEffect(() => {
    if (!options) return;
    for (const item of items) {
      if (item.status !== 'analyzing' || !item.sourceJobId || analyzing.current.has(item.id)) {
        continue;
      }
      analyzing.current.add(item.id);
      const { id, sourceJobId } = item;
      apiGet(
        `/api/conversion/sources/${encodeURIComponent(sourceJobId)}`,
        conversionSourceResponseSchema,
      )
        .then((source) => {
          setItems((list) =>
            list.map((entry) => (entry.id === id ? withSource(entry, source, options.gif) : entry)),
          );
        })
        .catch((error: unknown) => {
          update(id, { status: 'failed', error: errorMessage(error) });
        })
        .finally(() => {
          analyzing.current.delete(id);
        });
    }
  }, [items, options, update]);

  // Seguir por SSE las conversiones en curso (el server manda primero su estado actual).
  const activeJobIds = useMemo(
    () =>
      items
        .filter((item) => item.jobId !== null && isConverting(item))
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

  const pump = useCallback(() => {
    pumpUploads({ files, queue, current, update });
  }, [update]);

  // Al salir de la página se cancela lo que se estaba subiendo (no queda en la lista guardada).
  useEffect(
    () => () => {
      queue.current = [];
      current.current?.handle.abort();
    },
    [],
  );

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      if (!options) return;
      const skipped: string[] = [];
      const added: ConvertItem[] = [];
      for (const file of Array.from(list)) {
        if (file.size > options.maxUploadBytes) {
          skipped.push(
            `«${file.name}» pesa ${formatBytes(file.size)} y el máximo es ${formatBytes(options.maxUploadBytes)}: no se agregó.`,
          );
          continue;
        }
        const item = newUploadItem(newLocalId(), file);
        files.current.set(item.id, file);
        queue.current.push(item.id);
        added.push(item);
      }
      setNotices(skipped);
      if (added.length === 0) return;
      setItems((current) => [...current, ...added]);
      setSelectedId((selected) => selected ?? added[0]?.id ?? null);
      pump();
    },
    [options, pump],
  );

  /** Archivos del historial (`?origen=`): los que ya están en la lista no se repiten. */
  const addFromHistory = (jobIds: string[]) => {
    const present = new Set(items.map((item) => item.sourceJobId));
    const added = jobIds
      .filter((jobId) => !present.has(jobId))
      .map((jobId) => newHistoryItem(newLocalId(), jobId));
    const first = added[0];
    if (!first) return;
    setItems((list) => [...list, ...added]);
    setSelectedId(first.id);
  };

  const remove = (id: string) => {
    if (current.current?.id === id) current.current.handle.abort();
    queue.current = queue.current.filter((queued) => queued !== id);
    files.current.delete(id);
    const index = items.findIndex((item) => item.id === id);
    const next = items.filter((item) => item.id !== id);
    setItems((list) => list.filter((item) => item.id !== id));
    if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
  };

  const applyToAll = useCallback((id: string) => {
    setItems((list) => applyFormatToAll(list, id));
  }, []);

  const convertible = options ? items.filter((item) => isConvertible(item, options.gif)) : [];

  /** Crea una conversión por cada archivo listo. La cola del server limita cuántas corren a la vez. */
  const convertReady = async (notify: string[] = []) => {
    if (!options) return;
    setSubmitting(true);
    for (const item of items.filter((entry) => isConvertible(entry, options.gif))) {
      if (!item.sourceJobId || !item.preset) continue;
      try {
        const { jobId } = await apiPost('/api/jobs/convert', createJobResponseSchema, {
          sourceJobId: item.sourceJobId,
          preset: item.preset,
          maxHeight: item.maxHeight,
          ...(item.preset === 'gif' && item.gif ? { gif: item.gif } : {}),
          notify,
        });
        update(item.id, { status: 'job', jobId, job: null, error: null });
      } catch (error) {
        update(item.id, { error: errorMessage(error) });
      }
    }
    setSubmitting(false);
  };

  const cancel = (item: ConvertItem) => {
    if (!item.jobId) return;
    apiPost(`/api/jobs/${item.jobId}/cancel`, jobResponseSchema).catch((error: unknown) => {
      update(item.id, { error: errorMessage(error) });
    });
  };

  /** Una conversión que falló o se canceló: el server crea un trabajo nuevo con lo mismo. */
  const retry = (item: ConvertItem) => {
    if (!item.jobId) return;
    apiPost(`/api/jobs/${item.jobId}/retry`, createJobResponseSchema)
      .then(({ jobId }) => {
        update(item.id, { jobId, job: null, error: null });
      })
      .catch((error: unknown) => {
        update(item.id, { error: errorMessage(error) });
      });
  };

  /** Volver a elegir formato (otra salida del mismo archivo). */
  const convertAgain = (item: ConvertItem) => {
    update(item.id, {
      status: item.source ? 'ready' : 'analyzing',
      jobId: null,
      job: null,
      error: null,
    });
  };

  /** Un análisis que falló (por ejemplo, el server estaba reiniciando). */
  const reanalyze = (item: ConvertItem) => {
    if (item.sourceJobId) update(item.id, { status: 'analyzing', error: null });
  };

  const uploading = items.some((item) => item.status === 'uploading');
  // Cerrar la pestaña cancela las subidas en curso.
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
    convertibleCount: convertible.length,
    addFiles,
    addFromHistory,
    remove,
    update,
    applyToAll,
    convertReady,
    cancel,
    retry,
    convertAgain,
    reanalyze,
  };
}

export type ConvertBatch = ReturnType<typeof useConvertBatch>;
