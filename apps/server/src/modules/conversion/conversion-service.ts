import path from 'node:path';
import { availablePresets, CONVERSION_PRESETS } from '@sti-catcher/shared';
import type {
  ConversionRequest,
  ConversionSourceResponse,
  GifLimits,
  Job,
  SourceMedia,
} from '@sti-catcher/shared';
import { conversionRequestSchema } from '@sti-catcher/shared';
import type { Ffprobe, MediaInfo } from '../../adapters/ffprobe.ts';
import type { EnqueueInput, JobQueue } from '../../jobs/queue.ts';
import type { JobRecord } from '../../jobs/types.ts';
import type { Requester } from '../history/history-service.ts';
import type { ConversionParams } from './conversion-runner.ts';

export class ConversionError extends Error {
  override name = 'ConversionError';
  constructor(
    readonly code:
      | 'SOURCE_NOT_FOUND'
      | 'SOURCE_NOT_READY'
      | 'SOURCE_GONE'
      | 'SOURCE_UNREADABLE'
      | 'PRESET_NOT_AVAILABLE'
      | 'INVALID_GIF',
    message: string,
    readonly status: 404 | 409 | 410 | 422,
  ) {
    super(message);
  }
}

export type ConversionServiceDeps = {
  getJob: (id: string) => JobRecord | null;
  storageDir: string;
  filesDir: string;
  ffprobe: Ffprobe;
  queue: Pick<JobQueue, 'toApi' | 'enqueue'>;
  gifLimits: GifLimits;
};

export const toSourceMedia = (media: MediaInfo): SourceMedia => ({
  hasVideo: media.video !== null,
  hasAudio: media.audio !== null,
  durationSeconds: media.durationSeconds,
  width: media.video?.width ?? null,
  height: media.video?.height ?? null,
  videoCodec: media.video?.codec ?? null,
  audioCodec: media.audio?.codec ?? null,
});

/** Archivo de un job terminado, solo si queda dentro de STORAGE_DIR/files. */
export function resolveJobFile(
  record: JobRecord,
  storageDir: string,
  filesDir: string,
): string | null {
  if (record.filePath === null) return null;
  const absolute = path.resolve(storageDir, record.filePath);
  return absolute.startsWith(path.resolve(filesDir) + path.sep) ? absolute : null;
}

/** Margen al comparar el fin del GIF con la duración (redondeos de ffprobe). */
const DURATION_TOLERANCE = 0.1;
const fmt = (n: number) => n.toFixed(1).replace('.', ',');

/**
 * Conversión (SPEC §7): análisis del archivo de origen (un archivo subido o
 * cualquiera del historial) y creación del job. Valida contra lo que tiene
 * el archivo, no contra lo que dice el cliente.
 */
export function createConversionService(deps: ConversionServiceDeps) {
  const loadSource = async (id: string) => {
    const record = deps.getJob(id);
    if (!record || record.type === 'selftest') {
      throw new ConversionError('SOURCE_NOT_FOUND', 'No existe ese archivo.', 404);
    }
    if (record.status === 'expired') {
      throw new ConversionError(
        'SOURCE_GONE',
        'El archivo ya no está disponible en el servidor.',
        410,
      );
    }
    const file =
      record.status === 'done' ? resolveJobFile(record, deps.storageDir, deps.filesDir) : null;
    if (file === null) {
      throw new ConversionError(
        'SOURCE_NOT_READY',
        'Ese trabajo todavía no terminó o no tiene un archivo para convertir.',
        409,
      );
    }
    const media = await deps.ffprobe(file).catch(() => null);
    if (media === null) {
      throw new ConversionError('SOURCE_UNREADABLE', 'No se pudo leer el archivo de origen.', 422);
    }
    return { record, media: toSourceMedia(media) };
  };

  return {
    async getSource(id: string): Promise<ConversionSourceResponse> {
      const { record, media } = await loadSource(id);
      return { job: deps.queue.toApi(record), media, presets: availablePresets(media) };
    },

    async enqueue(request: ConversionRequest, requester: Requester): Promise<Job> {
      const parsed = conversionRequestSchema.parse(request);
      const { record, media } = await loadSource(parsed.sourceJobId);
      const preset = CONVERSION_PRESETS[parsed.preset];

      if (!availablePresets(media).includes(parsed.preset)) {
        throw new ConversionError(
          'PRESET_NOT_AVAILABLE',
          `«${preset.label}» no se puede generar a partir de este archivo: no tiene ${preset.needs === 'video' ? 'video' : 'audio'}.`,
          422,
        );
      }

      let gif: ConversionParams['gif'];
      if (parsed.preset === 'gif') {
        const options = parsed.gif;
        const limits = deps.gifLimits;
        if (!options) {
          throw new ConversionError(
            'INVALID_GIF',
            'Para el GIF hay que indicar inicio, fin, FPS y ancho.',
            422,
          );
        }
        const length = options.endSeconds - options.startSeconds;
        const problems = [
          media.durationSeconds !== null &&
          options.endSeconds > media.durationSeconds + DURATION_TOLERANCE
            ? `el fin (${fmt(options.endSeconds)} s) es posterior al final del video (${fmt(media.durationSeconds)} s)`
            : null,
          length > limits.maxSeconds + DURATION_TOLERANCE
            ? `el fragmento dura ${fmt(length)} s y el máximo es ${String(limits.maxSeconds)} s`
            : null,
          options.fps > limits.maxFps
            ? `el máximo de cuadros por segundo es ${String(limits.maxFps)}`
            : null,
          options.width > limits.maxWidth
            ? `el ancho máximo es ${String(limits.maxWidth)} px`
            : null,
        ].filter((problem): problem is string => problem !== null);
        if (problems.length > 0) {
          throw new ConversionError('INVALID_GIF', `GIF inválido: ${problems.join('; ')}.`, 422);
        }
        gif = options;
      }

      // Escalar solo hacia abajo y solo en presets de video; si no corresponde, se ignora.
      const maxHeight =
        preset.scalable &&
        parsed.maxHeight !== null &&
        media.height !== null &&
        parsed.maxHeight < media.height
          ? parsed.maxHeight
          : null;

      const params: ConversionParams = {
        sourceJobId: record.id,
        preset: parsed.preset,
        maxHeight,
        gif,
      };
      const input: EnqueueInput = {
        type: 'conversion',
        params,
        title: `${record.title ?? 'Archivo'} → ${preset.extension.toUpperCase()}`,
        parentJobId: record.id,
        clientId: requester.clientId,
        clientIp: requester.ip,
      };
      return deps.queue.enqueue(input);
    },
  };
}

export type ConversionService = ReturnType<typeof createConversionService>;
