import path from 'node:path';
import {
  CONVERSION_PRESETS,
  conversionPresetIdSchema,
  gifOptionsSchema,
} from '@sti-catcher/shared';
import { z } from 'zod';
import { FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import type { Ffprobe } from '../../adapters/ffprobe.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobRecord, JobRunner } from '../../jobs/types.ts';
import { buildConversionArgs } from './conversion-args.ts';
import { resolveJobFile } from './conversion-service.ts';

export const conversionParamsSchema = z.object({
  sourceJobId: z.uuid(),
  preset: conversionPresetIdSchema,
  maxHeight: z.number().int().positive().nullable(),
  gif: gifOptionsSchema.optional(),
});
export type ConversionParams = z.infer<typeof conversionParamsSchema>;

export type ConversionRunnerDeps = {
  getJob: (id: string) => JobRecord | null;
  storageDir: string;
  filesDir: string;
  ffprobe: Ffprobe;
  runFfmpeg: FfmpegRunner;
};

/**
 * Convierte el archivo de un job terminado (el origen) con un preset (SPEC §7).
 * El resultado es un job nuevo, vinculado al origen por `parent_job_id`.
 */
export function createConversionRunner(deps: ConversionRunnerDeps): JobRunner {
  return {
    async run({ job, signal, tempDir, reportProgress }) {
      const parsed = conversionParamsSchema.safeParse(job.params);
      if (!parsed.success) throw new JobError('Parámetros inválidos para la conversión.');
      const params = parsed.data;

      // El origen pudo borrarse o expirar mientras el job esperaba en la cola.
      const source = deps.getJob(params.sourceJobId);
      const inputPath =
        source?.status === 'done' ? resolveJobFile(source, deps.storageDir, deps.filesDir) : null;
      const media = inputPath === null ? null : await deps.ffprobe(inputPath).catch(() => null);
      if (inputPath === null || media === null) {
        throw new JobError('El archivo de origen ya no está disponible.');
      }

      const extension = CONVERSION_PRESETS[params.preset].extension;
      const outputPath = path.join(tempDir, `${job.id}.${extension}`);
      const plan = buildConversionArgs({
        preset: params.preset,
        inputPath,
        outputPath,
        media,
        maxHeight: params.maxHeight,
        ...(params.gif ? { gif: params.gif } : {}),
      });

      reportProgress({
        phase: 'converting',
        percent: 0,
        speedBytesPerSecond: null,
        speedRatio: null,
        etaSeconds: null,
      });
      try {
        await deps.runFfmpeg(plan.args, {
          signal,
          totalDurationSeconds: plan.totalDurationSeconds,
          onProgress: (p) => {
            reportProgress({
              phase: 'converting',
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
            'ffmpeg no pudo convertir el archivo. El detalle quedó en el log del servidor.',
            { cause: error },
          );
        }
        throw error;
      }

      const result = await deps.ffprobe(outputPath).catch(() => null);
      return {
        output: { tempPath: outputPath, extension: `.${extension}` },
        metadata: {
          format: extension,
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
