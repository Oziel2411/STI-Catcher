import { COMPRESSION_PRESETS, compressionRequestSchema } from '@sti-catcher/shared';
import type {
  CompressionOptions,
  CompressionRequest,
  CompressionSourceResponse,
  Job,
} from '@sti-catcher/shared';
import type { Ffprobe, MediaInfo } from '../../adapters/ffprobe.ts';
import type { EncoderRegistry } from '../../adapters/video-encoders.ts';
import type { EnqueueInput, JobQueue } from '../../jobs/queue.ts';
import type { JobRecord } from '../../jobs/types.ts';
import { toSourceMedia } from '../conversion/conversion-service.ts';
import { resolveJobFile } from '../files/job-files.ts';
import type { Requester } from '../history/history-service.ts';
import { firstAttempt } from './compression-attempts.ts';
import { toCompressionSource } from './compression-runner.ts';
import type { CompressionParams } from './compression-runner.ts';

export class CompressionError extends Error {
  override name = 'CompressionError';
  constructor(
    readonly code:
      | 'SOURCE_NOT_FOUND'
      | 'SOURCE_NOT_READY'
      | 'SOURCE_GONE'
      | 'SOURCE_UNREADABLE'
      | 'NO_VIDEO'
      | 'TARGET_NOT_REACHABLE',
    message: string,
    readonly status: 404 | 409 | 410 | 422,
  ) {
    super(message);
  }
}

export type CompressionServiceDeps = {
  getJob: (id: string) => JobRecord | null;
  storageDir: string;
  filesDir: string;
  ffprobe: Ffprobe;
  encoders: Pick<EncoderRegistry, 'current'>;
  queue: Pick<JobQueue, 'toApi' | 'enqueue'>;
};

/** Datos de quién lo pide y a quién avisar; lo mismo desde la API o encadenado (D-108). */
export type CompressionCreateInput = {
  sourceJobId: string;
  options: CompressionOptions;
  requester: Requester;
  notifyUserIds: readonly string[];
  noticeBatchId: string | null;
};

/** «Video (comprimido)», para el historial. */
const titleFor = (record: JobRecord) => `${record.title ?? 'Archivo'} (comprimido)`;

/**
 * Compresión (D-108): análisis del origen y creación del job. Valida contra
 * lo que tiene el archivo real (ffprobe), no contra lo que dice el cliente.
 *
 * `create` es la entrada única: la usa `POST /api/jobs/compress` y la van a
 * usar las acciones encadenadas (comprimir al terminar una descarga o una
 * grabación), desde `onDone` de la cola.
 */
export function createCompressionService(deps: CompressionServiceDeps) {
  const loadSource = async (id: string): Promise<{ record: JobRecord; media: MediaInfo }> => {
    const record = deps.getJob(id);
    if (!record || record.type === 'selftest') {
      throw new CompressionError('SOURCE_NOT_FOUND', 'No existe ese archivo.', 404);
    }
    if (record.status === 'expired') {
      throw new CompressionError(
        'SOURCE_GONE',
        'El archivo ya no está disponible en el servidor.',
        410,
      );
    }
    const file =
      record.status === 'done' ? resolveJobFile(record, deps.storageDir, deps.filesDir) : null;
    if (file === null) {
      throw new CompressionError(
        'SOURCE_NOT_READY',
        'Ese trabajo todavía no terminó o no tiene un archivo para comprimir.',
        409,
      );
    }
    const media = await deps.ffprobe(file).catch(() => null);
    if (media === null) {
      throw new CompressionError('SOURCE_UNREADABLE', 'No se pudo leer el archivo de origen.', 422);
    }
    if (media.video === null) {
      throw new CompressionError(
        'NO_VIDEO',
        'Ese archivo no tiene video: no hay nada para comprimir.',
        422,
      );
    }
    return { record, media };
  };

  const create = async (input: CompressionCreateInput): Promise<Job> => {
    const { record, media } = await loadSource(input.sourceJobId);
    const source = toCompressionSource(media);
    if (source === null) throw new Error('loadSource garantiza video');
    // Misma cuenta que hará el runner: si el tamaño no alcanza, se avisa ahora.
    const attempt = firstAttempt(source, input.options, await deps.encoders.current());
    if ('error' in attempt) {
      throw new CompressionError('TARGET_NOT_REACHABLE', attempt.error, 422);
    }
    const params: CompressionParams = { sourceJobId: record.id, options: input.options };
    const enqueue: EnqueueInput = {
      type: 'compression',
      params,
      title: titleFor(record),
      parentJobId: record.id,
      userId: input.requester.userId,
      notifyUserIds: [...input.notifyUserIds],
      noticeBatchId: input.noticeBatchId,
      clientIp: input.requester.ip,
    };
    return deps.queue.enqueue(enqueue);
  };

  return {
    async getSource(id: string): Promise<CompressionSourceResponse> {
      const { record, media } = await loadSource(id);
      return {
        job: deps.queue.toApi(record),
        media: {
          ...toSourceMedia(media),
          frameRate: media.video?.frameRate ?? null,
          sizeBytes: media.sizeBytes,
        },
        encoders: await deps.encoders.current(),
      };
    },

    create,

    /** `POST /api/jobs/compress`. */
    async enqueue(request: CompressionRequest, requester: Requester): Promise<Job> {
      const { sourceJobId, notify, batchId, ...options } = compressionRequestSchema.parse(request);
      return create({
        sourceJobId,
        options,
        requester,
        notifyUserIds: notify,
        noticeBatchId: batchId,
      });
    },
  };
}

export type CompressionService = ReturnType<typeof createCompressionService>;

/** Para la web y los mails: «Rápido 720p30» etc. */
export const compressionPresetLabel = (options: CompressionOptions) =>
  COMPRESSION_PRESETS[options.preset].label;
