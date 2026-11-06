import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { recordingContainer } from '@sti-catcher/shared';
import type { CreateRecordingRequest, Job } from '@sti-catcher/shared';
import type { RecordingSession, RecordingsRepository } from '../../db/recordings-repository.ts';
import type { JobQueue } from '../../jobs/queue.ts';
import type { Requester } from '../history/history-service.ts';
import type { RecordingParams } from './recording-runner.ts';

/** Tamaño máximo de un fragmento (cada uno son ~2 s; 1080p60 ronda 2–4 MB). */
export const MAX_CHUNK_BYTES = 64 * 1024 ** 2;
/** Cada cuánto se buscan grabaciones abandonadas. */
const SWEEP_INTERVAL_MS = 30_000;

export class RecordingError extends Error {
  override name = 'RecordingError';
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'NOT_OWNER'
      | 'NOT_RECORDING'
      | 'OUT_OF_ORDER'
      | 'CHUNK_TOO_LARGE'
      | 'CHUNK_INTERRUPTED'
      | 'EMPTY'
      | 'INSUFFICIENT_DISK',
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 507,
  ) {
    super(message);
  }
}

export type RecordingServiceDeps = {
  repo: RecordingsRepository;
  /** STORAGE_DIR/recordings: los crudos viven acá (no en tmp, que se vacía al arrancar). */
  recordingsDir: string;
  minFreeDiskBytes: number;
  readFreeDiskBytes: () => Promise<number>;
  queue: Pick<JobQueue, 'enqueue'>;
  idleMinutes: number;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
  now?: () => Date;
  newId?: () => string;
};

/** Ruta del archivo crudo de una sesión. */
export const rawRecordingPath = (dir: string, id: string, extension: string) =>
  path.join(dir, `${id}.${extension}`);

/** Descarta el cuerpo de un request que no se va a guardar (si no, la conexión queda colgada). */
const drain = (stream: Readable) => {
  stream.resume();
};

const fileSize = async (file: string) => {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
};

/**
 * Grabación de pantalla (SPEC §6). La grabación ocurre en el navegador; el
 * server recibe fragmentos cada ~2 s mientras se graba, en orden, y los
 * agrega al archivo crudo. Así una grabación larga no vive en la RAM del
 * navegador, y si se cierra la pestaña lo grabado hasta ese momento se conserva.
 *
 * Al terminar (botón, "Dejar de compartir", o inactividad: D-032) se crea un
 * job `recording` que normaliza a MP4 H.264 + AAC.
 */
export function createRecordingService(deps: RecordingServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const locks = new Map<string, Promise<unknown>>();
  let sweepTimer: NodeJS.Timeout | undefined;

  /** Serializa las operaciones de una misma sesión (fragmentos y cierre). */
  const withLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(id, settled);
    void settled.then(() => {
      if (locks.get(id) === settled) locks.delete(id);
    });
    return run;
  };

  const ownSession = (id: string, requester: Requester): RecordingSession => {
    const session = deps.repo.get(id);
    if (!session) throw new RecordingError('NOT_FOUND', 'No existe esa grabación.', 404);
    if (session.userId === null || session.userId !== requester.userId) {
      throw new RecordingError('NOT_OWNER', 'Esta grabación es de otra persona.', 403);
    }
    return session;
  };

  const assertDisk = async (extraBytes: number) => {
    if ((await deps.readFreeDiskBytes()) - extraBytes < deps.minFreeDiskBytes) {
      throw new RecordingError(
        'INSUFFICIENT_DISK',
        'No hay espacio suficiente en el disco del servidor para seguir grabando.',
        507,
      );
    }
  };

  /** Crea el job de procesamiento y cierra la sesión. */
  const finalize = async (session: RecordingSession): Promise<Job> => {
    const end = session.lastChunkAt ?? session.createdAt;
    const estimatedSeconds = Math.max(0, (Date.parse(end) - Date.parse(session.createdAt)) / 1000);
    const params: RecordingParams = {
      recordingId: session.id,
      extension: session.extension === 'mp4' ? 'mp4' : 'webm',
      fps: session.fps,
      estimatedSeconds,
    };
    const job = await deps.queue.enqueue({
      type: 'recording',
      params,
      title: session.title,
      userId: session.userId,
      notifyUserIds: session.notifyUserIds,
      clientIp: session.clientIp,
    });
    deps.repo.finalize(session.id, job.id);
    return job;
  };

  const service = {
    async create(request: CreateRecordingRequest, requester: Requester) {
      await assertDisk(0);
      const container = recordingContainer(request.mimeType);
      if (container === null) throw new Error('MIME no validado');
      const session = deps.repo.insert({
        id: newId(),
        mimeType: request.mimeType,
        extension: container,
        fps: request.fps,
        title: request.title,
        userId: requester.userId,
        notifyUserIds: request.notify ?? [],
        clientIp: requester.ip,
        createdAt: now().toISOString(),
      });
      return { recordingId: session.id, maxChunkBytes: MAX_CHUNK_BYTES };
    },

    appendChunk(
      id: string,
      seq: number,
      stream: Readable,
      declaredBytes: number | null,
      requester: Requester,
    ): Promise<{ nextSeq: number }> {
      return withLock(id, async () => {
        let session: RecordingSession;
        try {
          session = ownSession(id, requester);
          if (session.status !== 'recording') {
            throw new RecordingError('NOT_RECORDING', 'La grabación ya terminó.', 409);
          }
        } catch (error) {
          drain(stream);
          throw error;
        }
        // Un reintento de un fragmento que ya llegó: se ignora sin error.
        if (seq < session.nextSeq) {
          drain(stream);
          return { nextSeq: session.nextSeq };
        }
        if (seq > session.nextSeq) {
          drain(stream);
          throw new RecordingError(
            'OUT_OF_ORDER',
            `Falta el fragmento ${String(session.nextSeq)}: se esperaba antes que el ${String(seq)}.`,
            409,
          );
        }
        if (declaredBytes !== null && declaredBytes > MAX_CHUNK_BYTES) {
          drain(stream);
          throw new RecordingError('CHUNK_TOO_LARGE', 'El fragmento es demasiado grande.', 413);
        }
        try {
          await assertDisk(declaredBytes ?? 0);
        } catch (error) {
          drain(stream);
          throw error;
        }

        const file = rawRecordingPath(deps.recordingsDir, id, session.extension);
        const sizeBefore = await fileSize(file);
        try {
          await pipeline(
            stream,
            byteLimit(MAX_CHUNK_BYTES),
            createWriteStream(file, { flags: 'a' }),
          );
        } catch (error) {
          // Un fragmento cortado a la mitad no puede quedar en el archivo: se deshace y el navegador reintenta.
          await truncate(file, sizeBefore).catch(() => undefined);
          if (error instanceof RecordingError) throw error;
          throw new RecordingError(
            'CHUNK_INTERRUPTED',
            'El fragmento llegó incompleto. Reintentá.',
            400,
          );
        }
        const written = (await fileSize(file)) - sizeBefore;
        if (!deps.repo.recordChunk(id, seq, written, now().toISOString())) {
          await truncate(file, sizeBefore).catch(() => undefined);
          throw new RecordingError('NOT_RECORDING', 'La grabación ya terminó.', 409);
        }
        return { nextSeq: seq + 1 };
      });
    },

    finish(id: string, requester: Requester): Promise<Job | { jobId: string }> {
      return withLock(id, async () => {
        const session = ownSession(id, requester);
        // Idempotente: si el navegador reintenta el cierre, recibe el mismo job.
        if (session.status === 'finalized' && session.jobId !== null)
          return { jobId: session.jobId };
        if (session.status !== 'recording') {
          throw new RecordingError('NOT_RECORDING', 'La grabación ya terminó.', 409);
        }
        if (session.sizeBytes === 0) {
          deps.repo.discard(id);
          throw new RecordingError('EMPTY', 'No se llegó a grabar nada.', 409);
        }
        return finalize(session);
      });
    },

    /**
     * Cierra las grabaciones sin fragmentos nuevos desde hace `idleMinutes`
     * (D-032): pestaña cerrada, navegador colgado, corte de red o reinicio del
     * server. Lo que llegó se procesa; si no llegó nada, se descarta.
     */
    async sweepIdle(): Promise<void> {
      const before = new Date(now().getTime() - deps.idleMinutes * 60_000).toISOString();
      for (const idle of deps.repo.listIdle(before)) {
        await withLock(idle.id, async () => {
          const session = deps.repo.get(idle.id);
          if (session?.status !== 'recording') return;
          if (session.sizeBytes === 0) {
            deps.repo.discard(session.id);
            await rm(rawRecordingPath(deps.recordingsDir, session.id, session.extension), {
              force: true,
            });
            return;
          }
          try {
            const job = await finalize(session);
            deps.logger.info(
              { recordingId: session.id, jobId: job.id, bytes: session.sizeBytes },
              'Grabación cerrada por inactividad',
            );
          } catch (error) {
            // Se reintenta en el próximo barrido (p. ej. si no había espacio en disco).
            deps.logger.warn(
              { err: error, recordingId: session.id },
              'No se pudo cerrar la grabación',
            );
          }
        });
      }
    },

    start() {
      sweepTimer = setInterval(() => {
        void service.sweepIdle();
      }, SWEEP_INTERVAL_MS);
      sweepTimer.unref();
      void service.sweepIdle();
    },

    stop() {
      clearInterval(sweepTimer);
    },
  };
  return service;
}

/** Corta el stream si supera el máximo de un fragmento. */
function byteLimit(maxBytes: number) {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new RecordingError('CHUNK_TOO_LARGE', 'El fragmento es demasiado grande.', 413));
        return;
      }
      callback(null, chunk);
    },
  });
}

export type RecordingService = ReturnType<typeof createRecordingService>;
