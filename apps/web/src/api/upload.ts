import { apiErrorSchema, uploadResponseSchema } from '@sti-catcher/shared';
import { ApiClientError } from './client.ts';

export type UploadProgress = { loadedBytes: number; totalBytes: number };

export type UploadHandle = {
  promise: Promise<{ jobId: string }>;
  abort: () => void;
};

/**
 * Sube un archivo para convertir. Usa XMLHttpRequest y no fetch porque fetch
 * no informa el progreso de una subida, y con archivos de cientos de MB hace
 * falta mostrarlo.
 *
 * El cuerpo es el archivo tal cual (application/octet-stream) y el nombre va
 * en el header `x-file-name`: el server lo escribe directo a disco.
 */
export function uploadFile(
  file: File,
  onProgress: (progress: UploadProgress) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ jobId: string }>((resolve, reject) => {
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.upload.addEventListener('progress', (event) => {
      onProgress({
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : file.size,
      });
    });
    xhr.addEventListener('load', () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // sin cuerpo JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = uploadResponseSchema.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else
          reject(
            new ApiClientError(
              'Respuesta inesperada del servidor.',
              'INVALID_RESPONSE',
              xhr.status,
            ),
          );
        return;
      }
      const error = apiErrorSchema.safeParse(body);
      reject(
        error.success
          ? new ApiClientError(error.data.error.message, error.data.error.code, xhr.status)
          : new ApiClientError(
              `El servidor respondió con un error (${String(xhr.status)}).`,
              'HTTP_ERROR',
              xhr.status,
            ),
      );
    });
    xhr.addEventListener('error', () => {
      reject(new ApiClientError('Se perdió la conexión durante la subida.', 'NETWORK_ERROR', null));
    });
    xhr.addEventListener('abort', () => {
      reject(new ApiClientError('Subida cancelada.', 'ABORTED', null));
    });
    xhr.send(file);
  });
  return {
    promise,
    abort: () => {
      xhr.abort();
    },
  };
}
