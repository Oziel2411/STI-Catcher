import type { ApiError } from '@sti-catcher/shared';
import type { z } from 'zod';

/**
 * Error HTTP con mensaje para el usuario. Lo convierte en respuesta el
 * error handler de `app.ts`, con el formato `ApiError` de shared.
 */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly issues?: NonNullable<ApiError['error']['issues']>,
  ) {
    super(message);
  }
}

/**
 * Valida un input (body, params o query) con Zod. Si falla, lanza 400 con el
 * detalle por campo.
 *
 * Se usa en vez de `fastify-type-provider-zod` para no sumar dependencias
 * (su v7 exige @fastify/swagger) y porque alcanza con una línea por handler.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new HttpError(
    400,
    'VALIDATION_ERROR',
    'Los datos enviados no son válidos.',
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}
