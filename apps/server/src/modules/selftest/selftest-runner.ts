import path from 'node:path';
import { z } from 'zod';
import type { FileOps } from '../../adapters/files.ts';
import { buildSelftestArgs, FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobRunner } from '../../jobs/types.ts';

export const selftestParamsSchema = z.object({
  durationSeconds: z.number().int().min(1).max(600),
});
export type SelftestParams = z.infer<typeof selftestParamsSchema>;

export const selftestTitle = (durationSeconds: number) =>
  `Prueba del sistema (${String(durationSeconds)} s)`;

export type SelftestRunnerDeps = {
  runFfmpeg: FfmpegRunner;
  files: Pick<FileOps, 'fileSize' | 'removeFile'>;
};

/**
 * Prueba del sistema (D-030): ffmpeg genera un video sintético en la carpeta
 * temporal. Ejercita la cola, el progreso por SSE y la cancelación sin
 * depender de internet. Al terminar se borra el archivo: solo se informa el tamaño.
 */
export function createSelftestRunner(deps: SelftestRunnerDeps): JobRunner {
  return {
    async run({ job, signal, tempDir, reportProgress }) {
      const parsed = selftestParamsSchema.safeParse(job.params);
      if (!parsed.success) throw new JobError('Parámetros inválidos para la prueba del sistema.');
      const { durationSeconds } = parsed.data;
      const outputPath = path.join(tempDir, `${job.id}.mp4`);

      reportProgress({
        phase: 'processing',
        percent: 0,
        speedBytesPerSecond: null,
        speedRatio: null,
        etaSeconds: durationSeconds,
      });

      try {
        await deps.runFfmpeg(buildSelftestArgs({ durationSeconds, outputPath }), {
          signal,
          totalDurationSeconds: durationSeconds,
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
            'ffmpeg no pudo generar el video de prueba. El detalle quedó en el log del servidor.',
            { cause: error },
          );
        }
        throw error;
      }

      const sizeBytes = await deps.files.fileSize(outputPath);
      await deps.files.removeFile(outputPath);
      return { output: null, metadata: { sizeBytes, durationSeconds } };
    },
  };
}
