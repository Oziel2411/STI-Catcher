import path from 'node:path';
import { z } from 'zod';
import { FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import type { Ffprobe } from '../../adapters/ffprobe.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobRunner } from '../../jobs/types.ts';
import { buildRecordingArgs } from './recording-args.ts';
import { rawRecordingPath } from './recording-service.ts';

export const recordingParamsSchema = z.object({
  recordingId: z.uuid(),
  extension: z.enum(['mp4', 'webm']),
  fps: z.number().int().positive(),
  /** Tiempo entre el inicio y el último fragmento: el WebM crudo no trae duración. */
  estimatedSeconds: z.number().nonnegative().nullable(),
});
export type RecordingParams = z.infer<typeof recordingParamsSchema>;

export type RecordingRunnerDeps = {
  recordingsDir: string;
  ffprobe: Ffprobe;
  runFfmpeg: FfmpegRunner;
  removeFile: (filePath: string) => Promise<void>;
};

/**
 * Procesa una grabación terminada: del crudo de MediaRecorder a MP4 H.264 +
 * AAC que se puede adelantar. El crudo se borra solo si salió bien, así un
 * fallo se puede reintentar.
 */
export function createRecordingRunner(deps: RecordingRunnerDeps): JobRunner {
  return {
    async run({ job, signal, tempDir, reportProgress }) {
      const parsed = recordingParamsSchema.safeParse(job.params);
      if (!parsed.success) throw new JobError('Parámetros inválidos para la grabación.');
      const params = parsed.data;

      const inputPath = rawRecordingPath(deps.recordingsDir, params.recordingId, params.extension);
      const media = await deps.ffprobe(inputPath).catch(() => null);
      if (media === null || media.video === null) {
        throw new JobError('La grabación no se puede leer: está vacía, dañada o ya se procesó.');
      }

      const outputPath = path.join(tempDir, `${job.id}.mp4`);
      const plan = buildRecordingArgs({ inputPath, outputPath, media, fps: params.fps });
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
          totalDurationSeconds: media.durationSeconds ?? params.estimatedSeconds,
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
            'No se pudo procesar la grabación. El detalle quedó en el log del servidor.',
            { cause: error },
          );
        }
        throw error;
      }

      const result = await deps.ffprobe(outputPath).catch(() => null);
      await deps.removeFile(inputPath);
      return {
        output: { tempPath: outputPath, extension: '.mp4' },
        metadata: {
          format: 'mp4',
          durationSeconds: result?.durationSeconds ?? null,
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
