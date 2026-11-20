import path from 'node:path';
import { editPrecisionSchema, editSegmentsSchema } from '@sti-catcher/shared';
import { z } from 'zod';
import { FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import type { Ffprobe } from '../../adapters/ffprobe.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobRecord, JobRunner } from '../../jobs/types.ts';
import { resolveJobFile } from '../files/job-files.ts';
import { buildEditArgs } from './edit-args.ts';

/** Al dividir, cada job tiene un solo tramo; al unir, todos los que quedan (D-114). */
export const editParamsSchema = z.object({
  sourceJobId: z.uuid(),
  segments: editSegmentsSchema,
  precision: editPrecisionSchema,
});
export type EditParams = z.infer<typeof editParamsSchema>;

export type EditRunnerDeps = {
  getJob: (id: string) => JobRecord | null;
  storageDir: string;
  filesDir: string;
  ffprobe: Ffprobe;
  runFfmpeg: FfmpegRunner;
  /** Escribe la lista del demuxer concat (rápido con varios tramos). */
  writeTextFile: (filePath: string, content: string) => Promise<void>;
};

/**
 * Recorta o divide el archivo de un job terminado (D-114). El resultado es
 * un MP4 nuevo vinculado al origen por `parent_job_id`: el original no se toca.
 */
export function createEditRunner(deps: EditRunnerDeps): JobRunner {
  return {
    async run({ job, signal, tempDir, reportProgress }) {
      const parsed = editParamsSchema.safeParse(job.params);
      if (!parsed.success) throw new JobError('Parámetros inválidos para recortar el video.');
      const params = parsed.data;

      // El origen pudo borrarse o expirar mientras el job esperaba en la cola.
      const source = deps.getJob(params.sourceJobId);
      const inputPath =
        source?.status === 'done' ? resolveJobFile(source, deps.storageDir, deps.filesDir) : null;
      const media = inputPath === null ? null : await deps.ffprobe(inputPath).catch(() => null);
      if (inputPath === null || media === null) {
        throw new JobError('El archivo de origen ya no está disponible.');
      }
      if (media.video === null) throw new JobError('El archivo de origen no tiene video.');

      const outputPath = path.join(tempDir, `${job.id}.mp4`);
      const concatListPath = path.join(tempDir, `${job.id}-list.txt`);
      const plan = buildEditArgs({
        inputPath,
        outputPath,
        concatListPath,
        media,
        segments: params.segments,
        precision: params.precision,
      });
      if (plan.concatList !== null) await deps.writeTextFile(concatListPath, plan.concatList);

      reportProgress({
        phase: 'processing',
        percent: 0,
        speedBytesPerSecond: null,
        speedRatio: null,
        etaSeconds: null,
      });
      try {
        await deps.runFfmpeg(plan.args, {
          signal,
          totalDurationSeconds: plan.totalDurationSeconds,
          lowPriority: true,
          onProgress: (p) => {
            reportProgress({
              phase: 'processing',
              percent: p.percent,
              speedBytesPerSecond: null,
              speedRatio: p.speedRatio,
              etaSeconds: p.etaSeconds,
            });
          },
        });
      } catch (error) {
        if (error instanceof FfmpegError) {
          throw new JobError(
            'ffmpeg no pudo recortar el video. El detalle quedó en el log del servidor.',
            { cause: error },
          );
        }
        throw error;
      }

      const result = await deps.ffprobe(outputPath).catch(() => null);
      return {
        output: { tempPath: outputPath, extension: '.mp4' },
        metadata: {
          format: 'mp4',
          durationSeconds: result?.durationSeconds ?? plan.totalDurationSeconds,
          resolution: result?.video
            ? `${String(result.video.width)}x${String(result.video.height)}`
            : null,
          videoCodec: result?.video?.codec ?? null,
          audioCodec: result?.audio?.codec ?? null,
        },
      };
    },
  };
}
