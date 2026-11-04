import { z } from 'zod';

/** Tipos de trabajo. `selftest` genera un video sintético para verificar el sistema (D-030). */
export const JOB_TYPES = ['download', 'upload', 'conversion', 'recording', 'selftest'] as const;
export const jobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof jobTypeSchema>;

/**
 * Estados: `queued → running → done | failed | cancelled`.
 * Un job `done` pasa a `expired` cuando la retención borra su archivo.
 */
export const JOB_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
  'expired',
] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Estados en los que el job todavía puede cambiar (y cancelarse). */
export const ACTIVE_JOB_STATUSES = ['queued', 'running'] as const satisfies readonly JobStatus[];

export function isActiveStatus(status: JobStatus): boolean {
  return (ACTIVE_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

export const jobPhaseSchema = z.enum(['downloading', 'merging', 'converting', 'processing']);
export type JobPhase = z.infer<typeof jobPhaseSchema>;

/**
 * Progreso de un job en curso. Vive en memoria del server (no en la DB) y se
 * envía por SSE. Cada campo es null cuando la herramienta todavía no lo informa.
 */
export const jobProgressSchema = z.object({
  phase: jobPhaseSchema,
  percent: z.number().min(0).max(100).nullable(),
  /** Descargas: bytes por segundo. */
  speedBytesPerSecond: z.number().nonnegative().nullable(),
  /** ffmpeg: velocidad relativa al tiempo real (1 = tiempo real). */
  speedRatio: z.number().nonnegative().nullable(),
  etaSeconds: z.number().nonnegative().nullable(),
});
export type JobProgress = z.infer<typeof jobProgressSchema>;

export const jobSchema = z.object({
  id: z.uuid(),
  type: jobTypeSchema,
  status: jobStatusSchema,
  title: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** Mensaje para el usuario si el job falló. */
  error: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  /** Datos técnicos del archivo final (de ffprobe). */
  format: z.string().nullable(),
  /** "1920x1080". */
  resolution: z.string().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  parentJobId: z.uuid().nullable(),
  /**
   * Descargas con conversión encadenada (`then`): la conversión que se creó al
   * terminar la descarga. null mientras no existe (o si se borró).
   */
  followUpJobId: z.uuid().nullable(),
  /** Solo mientras el job está `running`. */
  progress: jobProgressSchema.nullable(),
});
export type Job = z.infer<typeof jobSchema>;

/** Eventos que viajan por SSE (`event: <type>`, `data: <JSON>`). */
export const jobEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('job.updated'), job: jobSchema }),
  z.object({ type: z.literal('job.progress'), jobId: z.uuid(), progress: jobProgressSchema }),
  /** Se borró del historial (otras pestañas lo quitan de la lista). */
  z.object({ type: z.literal('job.deleted'), jobId: z.uuid() }),
]);
export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobEventType = JobEvent['type'];
export const JOB_EVENT_TYPES = [
  'job.updated',
  'job.progress',
  'job.deleted',
] as const satisfies JobEventType[];

/** Id del job al que se refiere un evento. */
export function eventJobId(event: JobEvent): string {
  return event.type === 'job.updated' ? event.job.id : event.jobId;
}

// --- Requests / responses ----------------------------------------------------

export const jobIdParamsSchema = z.object({
  id: z.uuid({ error: 'Id de trabajo inválido.' }),
});

/** Lista separada por comas en un query string → array validado. */
const commaList = <T extends z.ZodType<unknown, string>>(item: T, max: number) =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(item).min(1).max(max));

export const listJobsQuerySchema = z.object({
  status: commaList(jobStatusSchema, JOB_STATUSES.length).optional(),
  type: commaList(jobTypeSchema, JOB_TYPES.length).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const listJobsResponseSchema = z.object({ jobs: z.array(jobSchema) });

export const eventsQuerySchema = z.object({
  /** Si se indica, el stream solo trae eventos de esos jobs. */
  jobIds: commaList(z.uuid({ error: 'Id de trabajo inválido.' }), 50).optional(),
});

export const createSelftestRequestSchema = z.object({
  /** Duración del video de prueba. Se genera a velocidad real: tarda eso mismo. */
  durationSeconds: z.number().int().min(5).max(600).default(60),
});
export type CreateSelftestRequest = z.input<typeof createSelftestRequestSchema>;

export const createJobResponseSchema = z.object({ jobId: z.uuid() });

export const jobResponseSchema = z.object({ job: jobSchema });
