import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Job, JobProgress, JobType } from '@sti-catcher/shared';
import type { FileOps } from '../adapters/files.ts';
import {
  INTERRUPTED_MESSAGE,
  JobAbort,
  JobError,
  JobRejectedError,
  UNEXPECTED_MESSAGE,
} from './errors.ts';
import type { JobEventBus } from './event-bus.ts';
import type {
  JobFinish,
  JobRecord,
  JobResult,
  JobRunner,
  JobsRepository,
  ListJobsFilter,
} from './types.ts';

/** Subconjunto de pino que usa la cola (así los tests pasan un logger falso). */
export type QueueLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export type JobQueueDeps = {
  repo: JobsRepository;
  bus: JobEventBus;
  runners: Partial<Record<JobType, JobRunner>>;
  files: Pick<FileOps, 'removeByPrefix' | 'moveFile' | 'fileSize'>;
  /** tempDir y filesDir deben estar en STORAGE_DIR (mismo volumen: mover es instantáneo). */
  paths: { tempDir: string; filesDir: string };
  maxConcurrent: number;
  minFreeDiskBytes: number;
  readFreeDiskBytes: () => Promise<number>;
  logger: QueueLogger;
  now?: () => Date;
  newId?: () => string;
  /** Mínimo entre dos eventos de progreso del mismo job. */
  progressIntervalMs?: number;
  /** Cuánto esperar a que los jobs corten al detener el server. */
  stopTimeoutMs?: number;
};

export type EnqueueInput = {
  type: JobType;
  params: unknown;
  title?: string | null;
  sourceUrl?: string | null;
  clientIp?: string | null;
  clientId?: string | null;
  parentJobId?: string | null;
};

export type CancelResult =
  | { outcome: 'cancelled'; job: Job }
  | { outcome: 'cancelling'; job: Job }
  | { outcome: 'not_active'; job: Job }
  | { outcome: 'not_found' };

export type JobQueue = {
  /** Crea el job (queued). Lanza JobRejectedError si no hay espacio en disco. */
  enqueue(input: EnqueueInput): Promise<Job>;
  cancel(id: string): CancelResult;
  get(id: string): Job | null;
  list(filter: ListJobsFilter): Job[];
  counts(): { running: number; queued: number; maxConcurrent: number };
  /** Representación para la API (incluye el progreso si está corriendo). */
  toApi(record: JobRecord): Job;
  /** done → expired y lo publica. false si el job no estaba en done. */
  expire(id: string): boolean;
  /** Borra un job terminado y publica `job.deleted`. false si no existe o está activo. */
  remove(id: string): boolean;
  /**
   * Registra un job que ya terminó sin pasar por la cola (p. ej. un archivo
   * subido: D-030 / DT-001). Queda `done` con su archivo y se publica.
   */
  recordCompleted(
    input: EnqueueInput & { id: string },
    result: Omit<JobFinish, 'status' | 'finishedAt'>,
  ): Job;
  /** Empieza a procesar la cola (incluye los queued que quedaron de antes de un reinicio). */
  start(): void;
  /** Corta los jobs en curso (quedan failed "interrumpido") y deja de tomar nuevos. */
  stop(): Promise<void>;
};

type RunningJob = { controller: AbortController; done: Promise<void> };

const GB = 1024 ** 3;
const formatGb = (bytes: number) => `${(bytes / GB).toFixed(1).replace('.', ',')} GB`;
const EXTENSION_PATTERN = /^\.[a-z0-9]{1,5}$/;

/**
 * Cola de jobs persistida en SQLite.
 *
 * - Concurrencia máxima `maxConcurrent`; el resto espera en estado queued,
 *   por orden de llegada.
 * - El progreso vive en memoria y se publica como máximo cada `progressIntervalMs`.
 * - La cola es dueña de la carpeta temporal: al terminar un job (bien o mal)
 *   borra todo lo que empiece con su id, y recién después publica el estado
 *   final. Cuando la UI ve "cancelado", ya no quedan archivos parciales.
 */
export function createJobQueue(deps: JobQueueDeps): JobQueue {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const progressIntervalMs = deps.progressIntervalMs ?? 250;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 10_000;
  const { repo, bus, logger } = deps;

  const running = new Map<string, RunningJob>();
  const progress = new Map<string, JobProgress>();
  const lastProgressSent = new Map<string, number>();
  const progressTimers = new Map<string, NodeJS.Timeout>();
  let accepting = false;
  let pumping = false;
  let pumpAgain = false;
  // pumpAgain lo cambian otras llamadas a pump() mientras esta espera (await).
  // Leerlo con una función evita que TypeScript asuma que sigue en false.
  const repeatRequested = () => pumpAgain;

  const toApi = (record: JobRecord): Job => ({
    id: record.id,
    type: record.type,
    status: record.status,
    title: record.title,
    sourceUrl: record.sourceUrl,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    sizeBytes: record.sizeBytes,
    durationSeconds: record.durationSeconds,
    format: record.format,
    resolution: record.resolution,
    videoCodec: record.videoCodec,
    audioCodec: record.audioCodec,
    parentJobId: record.parentJobId,
    progress: record.status === 'running' ? (progress.get(record.id) ?? null) : null,
  });

  const publishUpdated = (id: string) => {
    const record = repo.get(id);
    if (record) bus.publish({ type: 'job.updated', job: toApi(record) });
  };

  // --- Progreso ---------------------------------------------------------------

  const sendProgress = (id: string) => {
    const current = progress.get(id);
    if (!current || !running.has(id)) return;
    lastProgressSent.set(id, Date.now());
    bus.publish({ type: 'job.progress', jobId: id, progress: current });
  };

  const reportProgress = (id: string, value: JobProgress) => {
    if (!running.has(id)) return;
    progress.set(id, value);
    const elapsed = Date.now() - (lastProgressSent.get(id) ?? 0);
    if (elapsed >= progressIntervalMs) {
      sendProgress(id);
    } else if (!progressTimers.has(id)) {
      // Garantiza que el último valor siempre se envíe.
      progressTimers.set(
        id,
        setTimeout(() => {
          progressTimers.delete(id);
          sendProgress(id);
        }, progressIntervalMs - elapsed),
      );
    }
  };

  const clearProgress = (id: string) => {
    progress.delete(id);
    lastProgressSent.delete(id);
    const timer = progressTimers.get(id);
    if (timer) clearTimeout(timer);
    progressTimers.delete(id);
  };

  // --- Disco ------------------------------------------------------------------

  /** null si hay espacio; si no, el mensaje para el usuario. */
  const checkDisk = async (): Promise<string | null> => {
    const free = await deps.readFreeDiskBytes();
    if (free >= deps.minFreeDiskBytes) return null;
    return `Espacio insuficiente en el disco del servidor: quedan ${formatGb(free)} libres y se necesitan al menos ${formatGb(deps.minFreeDiskBytes)}. Pedí que liberen espacio o borrá trabajos viejos.`;
  };

  // --- Ejecución --------------------------------------------------------------

  const completeOutput = async (id: string, result: JobResult): Promise<JobFinish> => {
    const finish: JobFinish = { ...result.metadata, status: 'done', finishedAt: '' };
    if (result.output) {
      const { tempPath, extension } = result.output;
      if (!EXTENSION_PATTERN.test(extension)) {
        throw new Error(`Extensión inválida devuelta por el runner: ${extension}`);
      }
      const fileName = `${id}${extension}`;
      const destination = path.join(deps.paths.filesDir, fileName);
      await deps.files.moveFile(tempPath, destination);
      finish.sizeBytes = await deps.files.fileSize(destination);
      // Siempre con "/", independiente del SO: es un identificador, no una ruta para el cliente.
      finish.filePath = `files/${fileName}`;
    }
    return finish;
  };

  const runJob = async (record: JobRecord, runner: JobRunner, controller: AbortController) => {
    const { id } = record;
    let finish: JobFinish;
    try {
      const result = await runner.run({
        job: record,
        signal: controller.signal,
        tempDir: deps.paths.tempDir,
        reportProgress: (value) => {
          reportProgress(id, value);
        },
      });
      finish = await completeOutput(id, result);
    } catch (error) {
      const abort = controller.signal.aborted ? (controller.signal.reason as unknown) : null;
      if (abort instanceof JobAbort) {
        finish =
          abort.reason === 'cancel'
            ? { status: 'cancelled', finishedAt: '' }
            : { status: 'failed', finishedAt: '', error: INTERRUPTED_MESSAGE };
        logger.info({ jobId: id, reason: abort.reason }, 'Job abortado');
      } else if (error instanceof JobError) {
        finish = { status: 'failed', finishedAt: '', error: error.message };
        logger.warn({ jobId: id, err: error, cause: error.cause }, 'Job fallido');
      } else {
        finish = { status: 'failed', finishedAt: '', error: UNEXPECTED_MESSAGE };
        logger.error({ jobId: id, err: error }, 'Error inesperado en un job');
      }
    }

    // Limpieza antes de publicar el estado final (ver comentario de createJobQueue).
    try {
      await deps.files.removeByPrefix(deps.paths.tempDir, id);
    } catch (error) {
      logger.warn({ jobId: id, err: error }, 'No se pudieron borrar los temporales del job');
    }

    finish.finishedAt = now().toISOString();
    running.delete(id);
    clearProgress(id);
    repo.finish(id, finish);
    publishUpdated(id);
    logger.info({ jobId: id, status: finish.status }, 'Job terminado');
  };

  const startJob = (record: JobRecord): void => {
    const runner = deps.runners[record.type];
    if (!runner) {
      repo.finish(record.id, {
        status: 'failed',
        finishedAt: now().toISOString(),
        error: UNEXPECTED_MESSAGE,
      });
      publishUpdated(record.id);
      logger.error({ jobId: record.id, type: record.type }, 'No hay runner para este tipo de job');
      return;
    }
    if (!repo.markRunning(record.id, now().toISOString())) return; // lo cancelaron mientras tanto

    const controller = new AbortController();
    const entry: RunningJob = { controller, done: Promise.resolve() };
    running.set(record.id, entry);
    publishUpdated(record.id);
    logger.info({ jobId: record.id, type: record.type }, 'Job iniciado');

    const started = repo.get(record.id) ?? record;
    entry.done = runJob(started, runner, controller).finally(() => {
      void pump();
    });
  };

  const pump = async (): Promise<void> => {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        while (accepting && running.size < deps.maxConcurrent) {
          const next = repo.nextQueued();
          if (!next) break;
          const diskProblem = await checkDisk();
          if (diskProblem !== null) {
            if (
              repo.finish(next.id, {
                status: 'failed',
                finishedAt: now().toISOString(),
                error: diskProblem,
              })
            ) {
              publishUpdated(next.id);
            }
            continue;
          }
          startJob(next);
        }
      } while (repeatRequested() && accepting);
    } catch (error) {
      logger.error({ err: error }, 'Error en la cola de jobs');
    } finally {
      pumping = false;
    }
  };

  return {
    async enqueue(input) {
      if (!deps.runners[input.type]) {
        throw new JobRejectedError('NO_RUNNER', 'Este tipo de trabajo todavía no está disponible.');
      }
      const diskProblem = await checkDisk();
      if (diskProblem !== null) throw new JobRejectedError('INSUFFICIENT_DISK', diskProblem);

      const record = repo.insert({
        id: newId(),
        createdAt: now().toISOString(),
        type: input.type,
        params: input.params,
        title: input.title ?? null,
        sourceUrl: input.sourceUrl ?? null,
        clientIp: input.clientIp ?? null,
        clientId: input.clientId ?? null,
        parentJobId: input.parentJobId ?? null,
      });
      bus.publish({ type: 'job.updated', job: toApi(record) });
      void pump();
      return toApi(record);
    },

    cancel(id) {
      // Sin awaits: con better-sqlite3 (sincrónico) esta función es atómica respecto de la cola.
      const record = repo.get(id);
      if (!record) return { outcome: 'not_found' };

      if (record.status === 'queued') {
        repo.finish(id, { status: 'cancelled', finishedAt: now().toISOString() });
        publishUpdated(id);
        const updated = repo.get(id) ?? record;
        return { outcome: 'cancelled', job: toApi(updated) };
      }

      const entry = running.get(id);
      if (record.status === 'running' && entry) {
        if (!entry.controller.signal.aborted) entry.controller.abort(new JobAbort('cancel'));
        return { outcome: 'cancelling', job: toApi(record) };
      }

      return { outcome: 'not_active', job: toApi(record) };
    },

    get(id) {
      const record = repo.get(id);
      return record ? toApi(record) : null;
    },

    list(filter) {
      return repo.list(filter).map(toApi);
    },

    counts() {
      return { ...repo.countActive(), maxConcurrent: deps.maxConcurrent };
    },

    toApi,

    expire(id) {
      if (!repo.markExpired(id)) return false;
      publishUpdated(id);
      logger.info({ jobId: id }, 'Archivo de un trabajo ya no disponible: marcado como expirado');
      return true;
    },

    remove(id) {
      if (!repo.delete(id)) return false;
      bus.publish({ type: 'job.deleted', jobId: id });
      return true;
    },

    recordCompleted(input, result) {
      const timestamp = now().toISOString();
      repo.insert({
        id: input.id,
        createdAt: timestamp,
        type: input.type,
        params: input.params,
        title: input.title ?? null,
        sourceUrl: input.sourceUrl ?? null,
        clientIp: input.clientIp ?? null,
        clientId: input.clientId ?? null,
        parentJobId: input.parentJobId ?? null,
      });
      repo.markRunning(input.id, timestamp);
      repo.finish(input.id, { ...result, status: 'done', finishedAt: timestamp });
      const record = repo.get(input.id);
      if (!record) throw new Error(`No se pudo leer el job registrado ${input.id}`);
      bus.publish({ type: 'job.updated', job: toApi(record) });
      return toApi(record);
    },

    start() {
      accepting = true;
      void pump();
    },

    async stop() {
      accepting = false;
      const entries = [...running.values()];
      for (const entry of entries) entry.controller.abort(new JobAbort('shutdown'));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, stopTimeoutMs);
      });
      await Promise.race([Promise.allSettled(entries.map((e) => e.done)), timeout]);
      clearTimeout(timer);
    },
  };
}
