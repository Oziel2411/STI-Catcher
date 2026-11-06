import type { DownloadRequest, Job, ProbeResponse } from '@sti-catcher/shared';
import { downloadRequestSchema, followUpDownloadFormat } from '@sti-catcher/shared';
import { UrlBlockedError, UrlResolveError } from '../../adapters/url-guard.ts';
import type { UrlGuard } from '../../adapters/url-guard.ts';
import { YtdlpError } from '../../adapters/ytdlp.ts';
import type { Ytdlp } from '../../adapters/ytdlp.ts';
import type { EnqueueInput } from '../../jobs/queue.ts';
import type { DownloadParams } from './download-runner.ts';
import type { Requester } from '../history/history-service.ts';

/** Error con mensaje para el usuario y el código HTTP que corresponde. Las rutas lo traducen. */
export class MediaRequestError extends Error {
  override name = 'MediaRequestError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 422 | 429,
  ) {
    super(message);
  }
}

export type DownloadServiceDeps = {
  ytdlp: Pick<Ytdlp, 'probe'>;
  checkUrl: UrlGuard;
  enqueue: (input: EnqueueInput) => Promise<Job>;
  logger: { warn: (obj: object, msg: string) => void };
  /** Análisis simultáneos permitidos (cada uno es un yt-dlp de 5–10 s). */
  maxConcurrentProbes?: number;
};

export type DownloadService = {
  probe: (url: string) => Promise<ProbeResponse>;
  enqueue: (request: DownloadRequest, requester: Requester) => Promise<Job>;
};

export function createDownloadService(deps: DownloadServiceDeps): DownloadService {
  const maxProbes = deps.maxConcurrentProbes ?? 4;
  let activeProbes = 0;

  const assertUrlAllowed = async (url: string) => {
    try {
      await deps.checkUrl(url);
    } catch (error) {
      if (error instanceof UrlBlockedError)
        throw new MediaRequestError('URL_BLOCKED', error.message, 400);
      if (error instanceof UrlResolveError)
        throw new MediaRequestError('HOST_NOT_FOUND', error.message, 422);
      throw error;
    }
  };

  return {
    async probe(url) {
      // El análisis no es un job (responde en segundos), pero igual se limita:
      // sin login, nada impide que alguien lance cien a la vez.
      if (activeProbes >= maxProbes) {
        throw new MediaRequestError(
          'PROBE_BUSY',
          'Hay varios análisis en curso. Probá de nuevo en unos segundos.',
          429,
        );
      }
      activeProbes++;
      try {
        await assertUrlAllowed(url);
        return await deps.ytdlp.probe(url);
      } catch (error) {
        if (error instanceof YtdlpError) {
          deps.logger.warn(
            { url, code: error.info.code, stderr: error.stderrTail },
            'Análisis fallido',
          );
          throw new MediaRequestError(error.info.code, error.info.message, 422);
        }
        throw error;
      } finally {
        activeProbes--;
      }
    },

    async enqueue(request, requester) {
      const parsed = downloadRequestSchema.parse(request);
      await assertUrlAllowed(parsed.url);
      // Con conversión encadenada se baja lo que mejor sirve de origen, en
      // modo compatible: la conversión hace el resto (D-093).
      const format = parsed.then ? followUpDownloadFormat(parsed.then.preset) : parsed.format;
      const isVideo = format === 'mp4';
      const params: DownloadParams = {
        url: parsed.url,
        format,
        maxHeight: isVideo ? parsed.maxHeight : null,
        videoMode: parsed.then ? 'compat' : parsed.videoMode,
        then: parsed.then,
      };
      return deps.enqueue({
        type: 'download',
        params,
        title: parsed.title ?? parsed.url,
        sourceUrl: parsed.url,
        clientIp: requester.ip,
        userId: requester.userId,
      });
    },
  };
}
