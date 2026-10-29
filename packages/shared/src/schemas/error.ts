import { z } from 'zod';

/**
 * Formato único de error de la API. `message` está en español y se puede
 * mostrar tal cual al usuario; `code` es estable y sirve para lógica en la UI.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Detalle de validación por campo, si aplica. */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
