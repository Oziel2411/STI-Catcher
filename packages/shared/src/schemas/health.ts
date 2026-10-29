import { z } from 'zod';

/** Herramientas externas que usa el sistema. El orden es el de la página Estado. */
export const TOOL_NAMES = ['yt-dlp', 'ffmpeg', 'ffprobe', 'deno'] as const;
export const toolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof toolNameSchema>;

/**
 * Estado de una herramienta. No incluye la ruta en disco: la API no expone
 * rutas del servidor (quedan en el log).
 */
export const toolStatusSchema = z.object({
  name: toolNameSchema,
  version: z.string().nullable(),
  /** Mensaje para el usuario si la herramienta no está disponible. */
  error: z.string().nullable(),
});
export type ToolStatus = z.infer<typeof toolStatusSchema>;

export const diskStatusSchema = z.object({
  freeBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  minFreeBytes: z.number().nonnegative(),
  /** true si el espacio libre está por debajo de MIN_FREE_DISK_GB: no se aceptan jobs nuevos. */
  isLow: z.boolean(),
});
export type DiskStatus = z.infer<typeof diskStatusSchema>;

export const jobCountsSchema = z.object({
  running: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  maxConcurrent: z.number().int().positive(),
});
export type JobCounts = z.infer<typeof jobCountsSchema>;

export const healthResponseSchema = z.object({
  /** `degraded`: falta alguna herramienta o hay poco disco. */
  status: z.enum(['ok', 'degraded']),
  app: z.object({
    version: z.string(),
    nodeVersion: z.string(),
    uptimeSeconds: z.number().nonnegative(),
  }),
  tools: z.array(toolStatusSchema),
  disk: diskStatusSchema,
  jobs: jobCountsSchema,
  /** Momento en que se consultaron las versiones (ISO 8601). Se cachean unos segundos. */
  toolsCheckedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const healthQuerySchema = z.object({
  /** `?refresh=1` fuerza a volver a consultar las versiones, ignorando la caché. */
  refresh: z
    .enum(['0', '1'])
    .optional()
    .transform((value) => value === '1'),
});
