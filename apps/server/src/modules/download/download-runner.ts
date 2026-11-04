import path from 'node:path';
import { downloadFollowUpSchema, downloadFormatSchema, videoModeSchema } from '@sti-catcher/shared';
import { z } from 'zod';
import type { FileOps } from '../../adapters/files.ts';
import { buildRecodeArgs, FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import type { Ffprobe, MediaInfo } from '../../adapters/ffprobe.ts';
import { UrlBlockedError, UrlResolveError } from '../../adapters/url-guard.ts';
import type { UrlGuard } from '../../adapters/url-guard.ts';
import { outputTemplate, YtdlpError } from '../../adapters/ytdlp.ts';
import type { DownloadInfo, Ytdlp } from '../../adapters/ytdlp.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobRunner } from '../../jobs/types.ts';

export const downloadParamsSchema = z.object({
  url: z.string(),
  format: downloadFormatSchema,
  maxHeight: z.number().int().positive().nullable(),
  videoMode: videoModeSchema,
  /** Conversión a crear al terminar (D-093). La usa el follow-up, no este runner. */
  then: downloadFollowUpSchema.nullable().default(null),
});
export type DownloadParams = z.infer<typeof downloadParamsSchema>;

export type DownloadRunnerDeps = {
  ytdlp: Pick<Ytdlp, 'download'>;
  runFfmpeg: FfmpegRunner;
  ffprobe: Ffprobe;
  files: Pick<FileOps, 'fileSize' | 'removeFile'>;
  checkUrl: UrlGuard;
};

const describeMedia = (media: MediaInfo | null) => ({
  durationSeconds: media?.durationSeconds ?? null,
  resolution: media?.video ? `${String(media.video.width)}x${String(media.video.height)}` : null,
  videoCodec: media?.video?.codec ?? null,
  audioCodec: media?.audio?.codec ?? null,
});

/**
 * Descarga por URL (SPEC §5):
 * 1. Verifica de nuevo la URL (el DNS pudo cambiar desde que se creó el job).
 * 2. yt-dlp descarga a `tmp/<jobId>.<formato>`, ya unido y en el contenedor pedido.
 * 3. Modo "Recodificar a H.264": ffmpeg recodifica con progreso propio
 *    (lo hace este runner y no yt-dlp, que no informa progreso de esa etapa,
 *    justo la más lenta).
 * 4. ffprobe sobre el archivo final: duración, resolución y codecs reales.
 */
export function createDownloadRunner(deps: DownloadRunnerDeps): JobRunner {
  return {
    async run({ job, signal, tempDir, reportProgress }) {
      const parsed = downloadParamsSchema.safeParse(job.params);
      if (!parsed.success) throw new JobError('Parámetros inválidos para la descarga.');
      const params = parsed.data;

      try {
        await deps.checkUrl(params.url);
      } catch (error) {
        if (error instanceof UrlBlockedError || error instanceof UrlResolveError) {
          throw new JobError(error.message);
        }
        throw error;
      }

      // Objeto y no `let`: se completa desde un callback.
      const state: { info: DownloadInfo | null } = { info: null };
      try {
        await deps.ytdlp.download({
          url: params.url,
          format: params.format,
          maxHeight: params.maxHeight,
          mode: params.videoMode,
          outputTemplate: outputTemplate(tempDir, job.id),
          signal,
          onInfo: (info) => {
            state.info = info;
          },
          onProgress: (update) => {
            reportProgress({ ...update, speedRatio: null });
          },
        });
      } catch (error) {
        if (error instanceof YtdlpError) throw new JobError(error.info.message, { cause: error });
        throw error;
      }

      const downloaded = path.join(tempDir, `${job.id}.${params.format}`);
      try {
        await deps.files.fileSize(downloaded);
      } catch (error) {
        throw new JobError(
          'yt-dlp terminó sin generar el archivo esperado. El detalle quedó en el log del servidor.',
          { cause: error },
        );
      }

      let finalPath = downloaded;
      if (params.format === 'mp4' && params.videoMode === 'recode') {
        const source = await deps.ffprobe(downloaded).catch(() => null);
        const recoded = path.join(tempDir, `${job.id}.h264.mp4`);
        reportProgress({
          phase: 'converting',
          percent: 0,
          speedBytesPerSecond: null,
          speedRatio: null,
          etaSeconds: null,
        });
        try {
          await deps.runFfmpeg(buildRecodeArgs({ inputPath: downloaded, outputPath: recoded }), {
            signal,
            totalDurationSeconds: source?.durationSeconds ?? state.info?.durationSeconds ?? null,
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
              'No se pudo recodificar el video a H.264. El detalle quedó en el log del servidor.',
              { cause: error },
            );
          }
          throw error;
        }
        await deps.files.removeFile(downloaded);
        finalPath = recoded;
      }

      // Si ffprobe falla, el archivo igual sirve: solo faltan los datos técnicos.
      const media = await deps.ffprobe(finalPath).catch(() => null);
      const described = describeMedia(media);
      return {
        output: { tempPath: finalPath, extension: `.${params.format}` },
        metadata: {
          ...described,
          title: state.info?.title ?? null,
          durationSeconds: described.durationSeconds ?? state.info?.durationSeconds ?? null,
          format: params.format,
        },
      };
    },
  };
}
