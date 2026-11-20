import { EDIT_MIN_SEGMENT_SECONDS, editRequestSchema } from '@sti-catcher/shared';
import type { EditRequest, EditSegment, EditSourceResponse, Job } from '@sti-catcher/shared';
import type { Ffprobe, MediaInfo } from '../../adapters/ffprobe.ts';
import type { EnqueueInput, JobQueue } from '../../jobs/queue.ts';
import type { JobRecord } from '../../jobs/types.ts';
import { toSourceMedia } from '../conversion/conversion-service.ts';
import { resolveJobFile } from '../files/job-files.ts';
import type { Requester } from '../history/history-service.ts';
import type { NoticeBatchService } from '../notifications/notice-batches.ts';
import type { EditParams } from './edit-runner.ts';

export class EditError extends Error {
  override name = 'EditError';
  constructor(
    readonly code:
      | 'SOURCE_NOT_FOUND'
      | 'SOURCE_NOT_READY'
      | 'SOURCE_GONE'
      | 'SOURCE_UNREADABLE'
      | 'NO_VIDEO'
      | 'SEGMENT_OUT_OF_RANGE',
    message: string,
    readonly status: 404 | 409 | 410 | 422,
  ) {
    super(message);
  }
}

export type EditServiceDeps = {
  getJob: (id: string) => JobRecord | null;
  storageDir: string;
  filesDir: string;
  ffprobe: Ffprobe;
  queue: Pick<JobQueue, 'toApi' | 'enqueue'>;
  noticeBatches: Pick<NoticeBatchService, 'create' | 'close'>;
};

/** Margen con la duración de ffprobe (redondeos y el último cuadro). */
const DURATION_TOLERANCE = 0.1;

/**
 * Ajusta los tramos a la duración real: el fin que se pasa por un redondeo
 * queda en el final; uno que empieza después del final es un error.
 */
export function fitSegments(
  segments: readonly EditSegment[],
  durationSeconds: number | null,
): EditSegment[] | { error: string } {
  if (durationSeconds === null) return [...segments];
  const fitted: EditSegment[] = [];
  for (const segment of segments) {
    if (segment.end > durationSeconds + DURATION_TOLERANCE) {
      return { error: 'Hay un tramo que termina después del final del video.' };
    }
    const end = Math.min(segment.end, durationSeconds);
    if (end - segment.start < EDIT_MIN_SEGMENT_SECONDS - DURATION_TOLERANCE) {
      return { error: 'Hay un tramo demasiado corto al final del video.' };
    }
    fitted.push({ start: segment.start, end });
  }
  return fitted;
}

/** «Video (recortado)» o, al dividir, «Video (parte 2 de 3)». */
export const editTitle = (title: string | null, part: number | null, parts: number) =>
  part === null
    ? `${title ?? 'Video'} (recortado)`
    : `${title ?? 'Video'} (parte ${String(part)} de ${String(parts)})`;

/**
 * Recortar y dividir (D-112): análisis del origen y creación de los jobs.
 * Unir = un job con todos los tramos; dividir = un job por tramo, con un
 * solo aviso por mail para todos (D-105).
 */
export function createEditService(deps: EditServiceDeps) {
  const loadSource = async (id: string): Promise<{ record: JobRecord; media: MediaInfo }> => {
    const record = deps.getJob(id);
    if (!record || record.type === 'selftest') {
      throw new EditError('SOURCE_NOT_FOUND', 'No existe ese archivo.', 404);
    }
    if (record.status === 'expired') {
      throw new EditError('SOURCE_GONE', 'El archivo ya no está disponible en el servidor.', 410);
    }
    const file =
      record.status === 'done' ? resolveJobFile(record, deps.storageDir, deps.filesDir) : null;
    if (file === null) {
      throw new EditError(
        'SOURCE_NOT_READY',
        'Ese trabajo todavía no terminó o no tiene un archivo para recortar.',
        409,
      );
    }
    const media = await deps.ffprobe(file).catch(() => null);
    if (media === null) {
      throw new EditError('SOURCE_UNREADABLE', 'No se pudo leer el archivo de origen.', 422);
    }
    if (media.video === null) {
      throw new EditError(
        'NO_VIDEO',
        'Ese archivo no tiene video: no hay nada para recortar.',
        422,
      );
    }
    return { record, media };
  };

  return {
    async getSource(id: string): Promise<EditSourceResponse> {
      const { record, media } = await loadSource(id);
      return {
        job: deps.queue.toApi(record),
        media: { ...toSourceMedia(media), frameRate: media.video?.frameRate ?? null },
      };
    },

    /** `POST /api/jobs/edit`: devuelve los jobs en el orden de los tramos. */
    async enqueue(request: EditRequest, requester: Requester): Promise<Job[]> {
      const { sourceJobId, segments, output, precision, notify, batchId } =
        editRequestSchema.parse(request);
      const { record, media } = await loadSource(sourceJobId);
      const fitted = fitSegments(segments, media.durationSeconds);
      if ('error' in fitted) throw new EditError('SEGMENT_OUT_OF_RANGE', fitted.error, 422);

      const parts: EditSegment[][] =
        output === 'split' ? fitted.map((segment) => [segment]) : [fitted];
      // Dividir sin un pedido de la web: el server abre el suyo, así llega un solo mail.
      const ownBatch =
        batchId === null && parts.length > 1 && notify.length > 0 && requester.userId !== null
          ? deps.noticeBatches.create(requester.userId, notify)
          : null;

      const jobs: Job[] = [];
      for (const [i, part] of parts.entries()) {
        const params: EditParams = { sourceJobId: record.id, segments: part, precision };
        const enqueue: EnqueueInput = {
          type: 'edit',
          params,
          title: editTitle(record.title, parts.length > 1 ? i + 1 : null, parts.length),
          parentJobId: record.id,
          userId: requester.userId,
          notifyUserIds: [...notify],
          noticeBatchId: ownBatch ?? batchId,
          clientIp: requester.ip,
        };
        jobs.push(await deps.queue.enqueue(enqueue));
      }
      if (ownBatch !== null && requester.userId !== null) {
        deps.noticeBatches.close(ownBatch, requester.userId);
      }
      return jobs;
    },
  };
}

export type EditService = ReturnType<typeof createEditService>;
