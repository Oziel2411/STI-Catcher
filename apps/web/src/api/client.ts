import { apiErrorSchema } from '@sti-catcher/shared';
import type { z } from 'zod';

/** Error de la API con un mensaje listo para mostrar al usuario. */
export class ApiClientError extends Error {
  override name = 'ApiClientError';
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** Sin respuesta del server (red caída, server apagado o reiniciándose). */
export const NETWORK_ERROR_MESSAGE =
  'No se pudo conectar con el servidor. Revisá la red o probá de nuevo en unos segundos.';

/**
 * Mensaje para un error HTTP que no trae el formato `ApiError` (lo responde
 * otro antes que la app: el proxy de desarrollo, un reinicio, un límite).
 * Sin códigos ni términos técnicos: lo lee cualquier compañero.
 */
export function httpErrorMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return 'El servidor no responde: puede estar reiniciándose. Probá de nuevo en unos segundos.';
  }
  if (status === 413) return 'El archivo es demasiado grande para el servidor.';
  if (status === 429)
    return 'Hay demasiados pedidos a la vez. Esperá unos segundos y probá de nuevo.';
  if (status >= 500) {
    return 'El servidor tuvo un error inesperado. Si se repite, avisale a quien administra STI-Catcher.';
  }
  return `No se pudo completar el pedido (error ${String(status)}).`;
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  /** Se envía como JSON. */
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Request tipado: valida la respuesta contra el esquema de shared. Si el
 * server y la web quedan desincronizados, falla acá con un mensaje claro en
 * vez de romper más adelante en un componente.
 */
export async function apiRequest<S extends z.ZodType>(
  url: string,
  schema: S,
  { method = 'GET', body, signal }: RequestOptions = {},
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError(NETWORK_ERROR_MESSAGE, 'NETWORK_ERROR', null);
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    throw parsed.success
      ? new ApiClientError(parsed.data.error.message, parsed.data.error.code, response.status)
      : new ApiClientError(httpErrorMessage(response.status), 'HTTP_ERROR', response.status);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError(
      'El servidor respondió algo inesperado. Recargá la página: puede haberse actualizado.',
      'INVALID_RESPONSE',
      response.status,
    );
  }
  return parsed.data;
}

export const apiGet = <S extends z.ZodType>(url: string, schema: S, signal?: AbortSignal) =>
  apiRequest(url, schema, signal ? { signal } : {});

export const apiPost = <S extends z.ZodType>(url: string, schema: S, body?: unknown) =>
  apiRequest(url, schema, { method: 'POST', body: body ?? {} });

/** DELETE: el server responde 204 sin cuerpo; si falla, lanza ApiClientError con su mensaje. */
export async function apiDelete(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'DELETE', headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiClientError(NETWORK_ERROR_MESSAGE, 'NETWORK_ERROR', null);
  }
  if (response.ok) return;
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
  throw parsed.success
    ? new ApiClientError(parsed.data.error.message, parsed.data.error.code, response.status)
    : new ApiClientError(httpErrorMessage(response.status), 'HTTP_ERROR', response.status);
}
