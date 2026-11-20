import { z } from 'zod';
import { jobSchema, jobTypeSchema } from './jobs.ts';
import type { JobType } from './jobs.ts';

/** "Mis trabajos" (los de este navegador) o "Todos" (SPEC §8). */
export const HISTORY_SCOPES = ['mine', 'all'] as const;
export const historyScopeSchema = z.enum(HISTORY_SCOPES);
export type HistoryScope = z.infer<typeof historyScopeSchema>;

/** Tipos que aparecen en el historial (el selftest no). Filtro "Origen" (D-098). */
export const HISTORY_JOB_TYPES = [
  'download',
  'upload',
  'conversion',
  'compression',
  'edit',
  'recording',
] as const satisfies readonly JobType[];

export const historyQuerySchema = z.object({
  scope: historyScopeSchema.default('mine'),
  /** Búsqueda por título. Sin distinguir mayúsculas ni tildes ("cancion" encuentra "Canción"). */
  q: z
    .string()
    .trim()
    .max(200, { error: 'La búsqueda es demasiado larga.' })
    .optional()
    .transform((value) => (value ? value : undefined)),
  /** Creados desde (inclusive) / hasta (exclusive). El cliente manda el día local ya pasado a ISO. */
  from: z.iso.datetime({ error: 'Fecha inválida.' }).optional(),
  to: z.iso.datetime({ error: 'Fecha inválida.' }).optional(),
  /** Uno o varios tipos separados por comas. */
  type: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(jobTypeSchema.extract(HISTORY_JOB_TYPES)).min(1).max(HISTORY_JOB_TYPES.length))
    .optional(),
  /** Quién lo pidió: un `value` de `/api/history/requesters`. */
  user: z.string().trim().min(1).max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type HistoryQuery = z.input<typeof historyQuerySchema>;

/**
 * Una entrada del historial. `isMine` lo calcula el server con la cookie
 * anónima del navegador; la API nunca expone el clientId. `requester` es el
 * nombre de la PC que lo pidió (o su IP si no se encontró), D-098.
 */
export const historyItemSchema = jobSchema.extend({
  isMine: z.boolean(),
  /** Título del trabajo de origen (p. ej. el archivo del que salió una conversión). */
  parentTitle: z.string().nullable(),
  requester: z.string().nullable(),
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
  compression: z.number().int().nonnegative(),
  recording: z.number().int().nonnegative(),
});
export type ActiveJobsResponse = z.infer<typeof activeJobsResponseSchema>;

/** Valores para el filtro "Usuario": cada PC (o IP) con trabajos, la más reciente primero. */
export const historyRequestersResponseSchema = z.object({
  requesters: z.array(
    z.object({
      /** Lo que se manda en `?user=`. */
      value: z.string(),
      label: z.string(),
      total: z.number().int().nonnegative(),
    }),
  ),
});
export type HistoryRequestersResponse = z.infer<typeof historyRequestersResponseSchema>;

/** Cambiar el título de un trabajo propio (D-113). */
export const renameJobBodySchema = z.object({
  title: z
    .string({ error: 'Poné un título.' })
    .trim()
    .min(1, { error: 'Poné un título.' })
    .max(200, { error: 'El título es demasiado largo (hasta 200 caracteres).' }),
});
export type RenameJobBody = z.infer<typeof renameJobBodySchema>;

/** Tope de trabajos por pedido de borrado: una página del historial. */
export const HISTORY_BULK_MAX = 100;

/**
 * Borrar varios trabajos propios de una vez (D-113). `file` borra solo el
 * archivo (la fila queda como «archivo borrado»); `job`, la fila y el archivo.
 */
export const historyBulkDeleteBodySchema = z.object({
  ids: z
    .array(z.uuid({ error: 'Id de trabajo inválido.' }))
    .min(1, { error: 'No elegiste ningún trabajo.' })
    .max(HISTORY_BULK_MAX, {
      error: `Se pueden borrar hasta ${String(HISTORY_BULK_MAX)} a la vez.`,
    }),
  what: z.enum(['file', 'job']),
});
export type HistoryBulkDeleteBody = z.infer<typeof historyBulkDeleteBodySchema>;

export const historyBulkDeleteResponseSchema = z.object({
  /** Los que se borraron. */
  done: z.array(z.string()),
  /** Los que no, con el motivo para el usuario. */
  failed: z.array(z.object({ id: z.string(), message: z.string() })),
});
export type HistoryBulkDeleteResponse = z.infer<typeof historyBulkDeleteResponseSchema>;

export const fileQuerySchema = z.object({
  /** `inline=1`: para reproducir en el navegador; sin él, se descarga como archivo. */
  inline: z
    .enum(['0', '1'])
    .optional()
    .transform((value) => value === '1'),
});
