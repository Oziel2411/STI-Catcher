import { ApiClientError } from './client.ts';
import { uploadFile } from './upload.ts';
import type { UploadHandle } from './upload.ts';

export type UploadQueueCallbacks = {
  onProgress: (id: string, loadedBytes: number) => void;
  /** Subido: el server creó el job `upload` del archivo. */
  onUploaded: (id: string, jobId: string, sizeBytes: number) => void;
  onFailed: (id: string, message: string) => void;
};

/**
 * Subidas de a una (D-092): cada una usa todo el ancho de banda y respeta el
 * máximo del server; quitar un archivo corta solo su subida. La usan
 * Convertir y Comprimir.
 */
export function createUploadQueue(callbacks: UploadQueueCallbacks) {
  const files = new Map<string, File>();
  let queue: string[] = [];
  let current: { id: string; handle: UploadHandle } | null = null;

  const pump = (): void => {
    if (current) return;
    let id = queue.shift();
    while (id !== undefined && !files.has(id)) id = queue.shift();
    const file = id === undefined ? undefined : files.get(id);
    if (id === undefined || !file) return;
    const itemId = id;
    const handle = uploadFile(file, (progress) => {
      callbacks.onProgress(itemId, progress.loadedBytes);
    });
    current = { id: itemId, handle };
    handle.promise
      .then(({ jobId }) => {
        callbacks.onUploaded(itemId, jobId, file.size);
      })
      .catch((error: unknown) => {
        // Cancelada a propósito: el ítem ya se quitó de la lista.
        if (error instanceof ApiClientError && error.code === 'ABORTED') return;
        callbacks.onFailed(itemId, error instanceof Error ? error.message : 'Error desconocido.');
      })
      .finally(() => {
        files.delete(itemId);
        current = null;
        pump();
      });
  };

  return {
    add(id: string, file: File): void {
      files.set(id, file);
      queue.push(id);
      pump();
    },
    /** Quita un archivo: si se estaba subiendo, corta la subida. */
    remove(id: string): void {
      if (current?.id === id) current.handle.abort();
      queue = queue.filter((queued) => queued !== id);
      files.delete(id);
    },
    /** Al salir de la página: corta todo. */
    abortAll(): void {
      queue = [];
      current?.handle.abort();
    },
  };
}

export type UploadQueue = ReturnType<typeof createUploadQueue>;

// crypto.randomUUID solo existe en contexto seguro, y la app también se usa por http://<IP>.
let counter = 0;
/** Id local para un ítem de una lista (no es un job). */
export const newLocalId = () => `item-${Date.now().toString(36)}-${String(++counter)}`;
