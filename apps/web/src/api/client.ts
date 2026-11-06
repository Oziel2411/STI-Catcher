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

/** Evento que se dispara cuando el server dice que la sesión ya no vale (401, D-100). */
export const SESSION_EXPIRED_EVENT = 'sti:session-expired';

function notifyIfUnauthenticated(status: number, code: string): void {
  if (status === 401 && code === 'UNAUTHENTICATED') {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
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
    throw new ApiClientError('No se pudo conectar con el servidor.', 'NETWORK_ERROR', null);
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) notifyIfUnauthenticated(response.status, parsed.data.error.code);
    throw parsed.success
      ? new ApiClientError(parsed.data.error.message, parsed.data.error.code, response.status)
      : new ApiClientError(
          `El servidor respondió con un error (${String(response.status)}).`,
          'HTTP_ERROR',
          response.status,
        );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError(
      'La respuesta del servidor no tiene el formato esperado. ¿Están actualizados server y web?',
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
    throw new ApiClientError('No se pudo conectar con el servidor.', 'NETWORK_ERROR', null);
  }
  if (response.ok) return;
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
  if (parsed.success) notifyIfUnauthenticated(response.status, parsed.data.error.code);
  throw parsed.success
    ? new ApiClientError(parsed.data.error.message, parsed.data.error.code, response.status)
    : new ApiClientError(
        `El servidor respondió con un error (${String(response.status)}).`,
        'HTTP_ERROR',
        response.status,
      );
}
