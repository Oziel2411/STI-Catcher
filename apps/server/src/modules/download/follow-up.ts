import { CONVERSION_PRESETS } from '@sti-catcher/shared';
import type { Job } from '@sti-catcher/shared';
import { JobRejectedError, UNEXPECTED_MESSAGE } from '../../jobs/errors.ts';
import type { JobQueue } from '../../jobs/queue.ts';
import type { JobRecord, JobsRepository } from '../../jobs/types.ts';
import { ConversionError } from '../conversion/conversion-service.ts';
import type { ConversionService } from '../conversion/conversion-service.ts';
import type { ConversionParams } from '../conversion/conversion-runner.ts';
import { downloadParamsSchema } from './download-runner.ts';

export type FollowUpDeps = {
  conversion: Pick<ConversionService, 'enqueue'>;
  queue: Pick<JobQueue, 'recordFailed'>;
  repo: Pick<JobsRepository, 'setFollowUp'>;
  logger: { warn: (obj: object, msg: string) => void };
};

/**
 * Conversión encadenada a una descarga (D-093). Se engancha en `onDone` de la
 * cola: cuando una descarga con `then` termina bien, crea la conversión por el
 * mismo camino que `POST /api/jobs/convert` (mismas validaciones) y la vincula
 * con `follow_up_job_id`.
 *
 * Si las opciones no sirven para lo que se bajó (p. ej. el GIF termina después
 * del final del video), igual queda una conversión, fallida y con el motivo:
 * así el usuario lo ve en la misma fila en vez de que no pase nada.
 */
export function createFollowUps(deps: FollowUpDeps) {
  return async (record: JobRecord): Promise<void> => {
    if (record.type !== 'download' || record.followUpJobId !== null) return;
    const parsed = downloadParamsSchema.safeParse(record.params);
    const then = parsed.success ? parsed.data.then : null;
    if (!then) return;

    const requester = { clientId: record.clientId ?? '', ip: record.clientIp };
    let job: Job;
    try {
      job = await deps.conversion.enqueue({ sourceJobId: record.id, ...then }, requester);
    } catch (error) {
      const known = error instanceof ConversionError || error instanceof JobRejectedError;
      if (!known) throw error;
      deps.logger.warn(
        { jobId: record.id, code: error.code },
        'No se pudo crear la conversión encadenada',
      );
      const params: ConversionParams = {
        sourceJobId: record.id,
        preset: then.preset,
        maxHeight: then.maxHeight,
        gif: then.gif,
      };
      job = deps.queue.recordFailed(
        {
          type: 'conversion',
          params,
          title: `${record.title ?? 'Archivo'} → ${CONVERSION_PRESETS[then.preset].extension.toUpperCase()}`,
          parentJobId: record.id,
          clientId: record.clientId,
          clientIp: record.clientIp,
        },
        error.message || UNEXPECTED_MESSAGE,
      );
    }
    deps.repo.setFollowUp(record.id, job.id);
  };
}
