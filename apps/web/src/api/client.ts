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

/**
 * GET tipado: valida la respuesta contra el esquema de shared. Si el server y
 * la web quedan desincronizados, falla acá con un mensaje claro en vez de
 * romper más adelante en un componente.
 */
export async function apiGet<S extends z.ZodType>(
  url: string,
  schema: S,
  init?: RequestInit,
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError('No se pudo conectar con el servidor.', 'NETWORK_ERROR', null);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    throw parsed.success
      ? new ApiClientError(parsed.data.error.message, parsed.data.error.code, response.status)
      : new ApiClientError(
          `El servidor respondió con un error (${response.status}).`,
          'HTTP_ERROR',
          response.status,
        );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiClientError(
      'La respuesta del servidor no tiene el formato esperado. ¿Están actualizados server y web?',
      'INVALID_RESPONSE',
      response.status,
    );
  }
  return parsed.data;
}
