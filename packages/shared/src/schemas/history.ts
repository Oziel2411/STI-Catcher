import { z } from 'zod';
import { jobSchema } from './jobs.ts';

/** "Mis trabajos" (los de este navegador) o "Todos" (SPEC §8). */
export const HISTORY_SCOPES = ['mine', 'all'] as const;
export const historyScopeSchema = z.enum(HISTORY_SCOPES);
export type HistoryScope = z.infer<typeof historyScopeSchema>;

export const historyQuerySchema = z.object({
  scope: historyScopeSchema.default('mine'),
  /** Búsqueda por título. Sin distinguir mayúsculas ni tildes ("cancion" encuentra "Canción"). */
  q: z
    .string()
    .trim()
    .max(200, { error: 'La búsqueda es demasiado larga.' })
    .optional()
    .transform((value) => (value ? value : undefined)),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type HistoryQuery = z.input<typeof historyQuerySchema>;

/**
 * Una entrada del historial. `isMine` lo calcula el server con la cookie
 * anónima del navegador; la API nunca expone el clientId ni la IP de nadie.
 */
export const historyItemSchema = jobSchema.extend({
  isMine: z.boolean(),
  /** Título del trabajo de origen (p. ej. el archivo del que salió una conversión). */
  parentTitle: z.string().nullable(),
});
export type HistoryItem = z.infer<typeof historyItemSchema>;

export const historyResponseSchema = z.object({
  items: z.array(historyItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

/**
 * Trabajos en cola o en curso de este navegador, para los contadores de la
 * barra lateral. La conversión encadenada a una descarga cuenta como descarga
 * (en Descargar sigue siendo la misma fila).
 */
export const activeJobsResponseSchema = z.object({
  download: z.number().int().nonnegative(),
  conversion: z.number().int().nonnegative(),
  recording: z.number().int().nonnegative(),
});
export type ActiveJobsResponse = z.infer<typeof activeJobsResponseSchema>;

export const fileQuerySchema = z.object({
  /** `inline=1`: para reproducir en el navegador; sin él, se descarga como archivo. */
  inline: z
    .enum(['0', '1'])
    .optional()
    .transform((value) => value === '1'),
});
