import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Job } from '@sti-catcher/shared';
import type { FileOps } from '../../adapters/files.ts';
import type { Ffprobe } from '../../adapters/ffprobe.ts';
import type { JobQueue } from '../../jobs/queue.ts';
import type { Requester } from '../history/history-service.ts';

/** Error con mensaje para el usuario y el código HTTP que corresponde. */
export class UploadError extends Error {
  override name = 'UploadError';
  constructor(
    readonly code: 'TOO_LARGE' | 'INSUFFICIENT_DISK' | 'INTERRUPTED' | 'NOT_MEDIA',
    message: string,
    readonly status: 400 | 413 | 422 | 507,
  ) {
    super(message);
  }
}

export type UploadServiceDeps = {
  tempDir: string;
  filesDir: string;
  maxUploadBytes: number;
  minFreeDiskBytes: number;
  readFreeDiskBytes: () => Promise<number>;
  ffprobe: Ffprobe;
  files: Pick<FileOps, 'moveFile' | 'removeFile'>;
  queue: Pick<JobQueue, 'recordCompleted'>;
  newId?: () => string;
};

export type UploadInput = {
  stream: Readable;
  /** Content-Length, si el navegador lo mandó. */
  declaredBytes: number | null;
  /** Nombre original: solo se usa como título, nunca como ruta. */
  fileName: string;
  requester: Requester;
};

const MB = 1024 ** 2;
const EXTENSION = /^\.[a-z0-9]{1,5}$/;

/** "C:\fakepath\Video final.MOV" → { title: "Video final.MOV", extension: ".mov" } */
export function describeUploadName(fileName: string): { title: string; extension: string } {
  // El nombre viene del cliente: se toma solo la última parte (sin carpetas) y sin caracteres de control.
  // eslint-disable-next-line no-control-regex -- se quitan justamente los caracteres de control
  const base = (fileName.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const title = base.slice(0, 300) || 'Archivo subido';
  const extension = path.extname(base).toLowerCase();
  return { title, extension: EXTENSION.test(extension) ? extension : '.bin' };
}

/** Cuenta bytes mientras pasan y corta si se supera el límite. */
function byteLimit(maxBytes: number) {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(
          new UploadError(
            'TOO_LARGE',
            `El archivo supera el máximo permitido (${String(Math.round(maxBytes / MB))} MB).`,
            413,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Subida de un archivo para convertir (SPEC §7):
 * - Se escribe en streaming a disco, nunca entero en memoria, con límite MAX_UPLOAD_MB.
 * - ffprobe confirma que es video o audio; si no, se borra.
 * - Queda en el historial como un job `upload` ya terminado (D-030), para que
 *   la conversión tenga un `parent_job_id` real y la retención lo borre.
 */
export function createUploadService(deps: UploadServiceDeps) {
  const newId = deps.newId ?? randomUUID;
  const tooLarge = () =>
    new UploadError(
      'TOO_LARGE',
      `El archivo supera el máximo permitido (${String(Math.round(deps.maxUploadBytes / MB))} MB).`,
      413,
    );

  return async ({ stream, declaredBytes, fileName, requester }: UploadInput): Promise<Job> => {
    // Rechazar antes de leer nada si ya se sabe que no entra.
    if (declaredBytes !== null && declaredBytes > deps.maxUploadBytes) {
      stream.resume(); // descartar el cuerpo para que la conexión no quede colgada
      throw tooLarge();
    }
    const free = await deps.readFreeDiskBytes();
    if (free - (declaredBytes ?? 0) < deps.minFreeDiskBytes) {
      stream.resume();
      throw new UploadError(
        'INSUFFICIENT_DISK',
        'No hay espacio suficiente en el disco del servidor para recibir el archivo.',
        507,
      );
    }

    const id = newId();
    // Empieza con el id del job: la recuperación al arrancar limpia tmp si algo queda a medias.
    const tempPath = path.join(deps.tempDir, `${id}.upload`);
    try {
      await pipeline(stream, byteLimit(deps.maxUploadBytes), createWriteStream(tempPath));
    } catch (error) {
      await deps.files.removeFile(tempPath);
      if (error instanceof UploadError) throw error;
      throw new UploadError('INTERRUPTED', 'La subida se interrumpió. Probá de nuevo.', 400);
    }

    const media = await deps.ffprobe(tempPath).catch(() => null);
    if (media === null || (media.video === null && media.audio === null)) {
      await deps.files.removeFile(tempPath);
      throw new UploadError(
        'NOT_MEDIA',
        'El archivo no es un video ni un audio que se pueda leer.',
        422,
      );
    }

    const { title, extension } = describeUploadName(fileName);
    const fileNameOnDisk = `${id}${extension}`;
    await deps.files.moveFile(tempPath, path.join(deps.filesDir, fileNameOnDisk));

    return deps.queue.recordCompleted(
      {
        id,
        type: 'upload',
        params: {},
        title,
        clientId: requester.clientId,
        clientIp: requester.ip,
      },
      {
        filePath: `files/${fileNameOnDisk}`,
        sizeBytes: media.sizeBytes,
        durationSeconds: media.durationSeconds,
        format: extension.slice(1),
        resolution: media.video
          ? `${String(media.video.width)}x${String(media.video.height)}`
          : null,
        videoCodec: media.video?.codec ?? null,
        audioCodec: media.audio?.codec ?? null,
      },
    );
  };
}

export type UploadService = ReturnType<typeof createUploadService>;
