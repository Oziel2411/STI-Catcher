import path from 'node:path';
import { COMPRESSION_PRESETS, compressionOptionsSchema } from '@sti-catcher/shared';
import type { CompressionSource } from '@sti-catcher/shared';
import { z } from 'zod';
import { FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import type { Ffprobe, MediaInfo } from '../../adapters/ffprobe.ts';
import type { EncoderRegistry } from '../../adapters/video-encoders.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobRecord, JobRunner } from '../../jobs/types.ts';
import { resolveJobFile } from '../files/job-files.ts';
import { buildCompressionArgs } from './compression-args.ts';
import { firstAttempt, nextAttempt } from './compression-attempts.ts';
import type { Attempt, AttemptOutcome } from './compression-attempts.ts';

export const compressionParamsSchema = z.object({
  sourceJobId: z.uuid(),
  options: compressionOptionsSchema,
});
export type CompressionParams = z.infer<typeof compressionParamsSchema>;

export type CompressionRunnerDeps = {
  getJob: (id: string) => JobRecord | null;
  storageDir: string;
  filesDir: string;
  ffprobe: Ffprobe;
  runFfmpeg: FfmpegRunner;
  encoders: EncoderRegistry;
  fileSize: (filePath: string) => Promise<number>;
  logger: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
};

export const toCompressionSource = (media: MediaInfo): CompressionSource | null =>
  media.video === null
    ? null
    : {
        width: media.video.width,
        height: media.video.height,
        frameRate: media.video.frameRate,
        durationSeconds: media.durationSeconds,
        hasAudio: media.audio !== null,
        sizeBytes: media.sizeBytes,
      };

/**
 * Comprime el archivo de un job terminado (D-108). El resultado es un job
 * nuevo, vinculado al origen por `parent_job_id`. Corre los intentos que
 * decide `nextAttempt`: por CPU si la GPU falla, y uno más bajo si con tamaño
 * objetivo se pasó.
 */
export function createCompressionRunner(deps: CompressionRunnerDeps): JobRunner {
  return {
    async run({ job, signal, tempDir, reportProgress }) {
      const parsed = compressionParamsSchema.safeParse(job.params);
      if (!parsed.success) throw new JobError('Parámetros inválidos para la compresión.');
      const { options } = parsed.data;
      const codec = COMPRESSION_PRESETS[options.preset].codec;

      // El origen pudo borrarse o expirar mientras el job esperaba en la cola.
      const sourceJob = deps.getJob(parsed.data.sourceJobId);
      const inputPath =
        sourceJob?.status === 'done'
          ? resolveJobFile(sourceJob, deps.storageDir, deps.filesDir)
          : null;
      const media = inputPath === null ? null : await deps.ffprobe(inputPath).catch(() => null);
      if (inputPath === null || media === null) {
        throw new JobError('El archivo de origen ya no está disponible.');
      }
      // Constantes ya validadas, para usarlas dentro de runAttempt.
      const input: string = inputPath;
      const probed: MediaInfo = media;
      const source = toCompressionSource(media);
      if (source === null) throw new JobError('El archivo de origen no tiene video.');

      const outputPath = path.join(tempDir, `${job.id}.mp4`);
      const first = firstAttempt(source, options, await deps.encoders.current());
      if ('error' in first) throw new JobError(first.error);

      const progress = (percent: number | null, speedRatio: number | null, eta: number | null) => {
        reportProgress({
          phase: 'converting',
          percent,
          speedBytesPerSecond: null,
          speedRatio,
          etaSeconds: eta,
        });
      };

      let attempt: Attempt = first;
      let gpuFellBack = false;
      for (;;) {
        progress(0, null, null);
        const outcome = await runAttempt(attempt);
        // La GPU queda descartada recién si la CPU pudo con el mismo archivo: si
        // fallan las dos, el problema es el archivo (o el disco), no la GPU.
        if (gpuFellBack && outcome.kind === 'encoded') {
          deps.encoders.markGpuFailed(codec);
          gpuFellBack = false;
        }
        const decision = nextAttempt(source, options, attempt, outcome);
        if (decision.kind === 'done') break;
        if (decision.kind === 'fail') throw new JobError(decision.message);
        if (decision.reason === 'gpu-failed') gpuFellBack = true;
        deps.logger.info(
          { jobId: job.id, reason: decision.reason, next: decision.attempt },
          'Se repite la compresión',
        );
        attempt = decision.attempt;
      }

      const result = await deps.ffprobe(outputPath).catch(() => null);
      return {
        output: { tempPath: outputPath, extension: '.mp4' },
        metadata: {
          format: 'mp4',
          durationSeconds: result?.durationSeconds ?? media.durationSeconds,
          resolution: result?.video
            ? `${String(result.video.width)}x${String(result.video.height)}`
            : null,
          videoCodec: result?.video?.codec ?? null,
          audioCodec: result?.audio?.codec ?? null,
        },
      };

      async function runAttempt(current: Attempt): Promise<AttemptOutcome> {
        const plan = buildCompressionArgs({
          inputPath: input,
          outputPath,
          media: probed,
          options,
          encoder: current.encoder,
          videoKbps: current.videoKbps,
          passLogPrefix: path.join(tempDir, `${job.id}-pass`),
        });
        const share = 100 / plan.runs.length;
        try {
          for (const [index, run] of plan.runs.entries()) {
            await deps.runFfmpeg(run.args, {
              signal,
              totalDurationSeconds: plan.totalDurationSeconds,
              lowPriority: true,
              onProgress: (p) => {
                // Dos pasadas: la primera es 0–50 % y la segunda 50–100 %.
                const percent =
                  p.percent === null ? null : index * share + (p.percent * share) / 100;
                const runsLeft = plan.runs.length - index - 1;
                const eta =
                  p.etaSeconds === null ||
                  plan.totalDurationSeconds === null ||
                  p.speedRatio === null
                    ? p.etaSeconds
                    : p.etaSeconds +
                      (runsLeft * plan.totalDurationSeconds) / Math.max(p.speedRatio, 0.01);
                progress(percent, p.speedRatio, eta);
              },
            });
          }
        } catch (error) {
          if (!(error instanceof FfmpegError)) throw error;
          deps.logger.warn(
            { jobId: job.id, encoder: current.encoder, stderr: error.stderrTail.slice(-5) },
            'ffmpeg falló al comprimir',
          );
          if (current.encoder === 'qsv') return { kind: 'gpu-failed' };
          throw new JobError(
            'ffmpeg no pudo comprimir el archivo. El detalle quedó en el log del servidor.',
            { cause: error },
          );
        }
        return { kind: 'encoded', sizeBytes: await deps.fileSize(outputPath) };
      }
    },
  };
}
