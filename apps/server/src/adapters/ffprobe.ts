import { z } from 'zod';
import type { CommandRunner } from './process.ts';

export type MediaInfo = {
  durationSeconds: number | null;
  /** Nombre del contenedor según ffprobe, p. ej. "mov,mp4,m4a,3gp,3g2,mj2". */
  formatName: string | null;
  sizeBytes: number | null;
  video: {
    codec: string;
    /** Ancho y alto como se ve (con la rotación de los videos verticales ya aplicada). */
    width: number;
    height: number;
    pixFmt: string | null;
    /** Cuadros por segundo promedio; null si ffprobe no lo sabe (p. ej. WebM de MediaRecorder). */
    frameRate: number | null;
  } | null;
  audio: { codec: string; channels: number | null } | null;
};

export function buildFfprobeArgs(filePath: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', filePath];
}

const streamSchema = z.looseObject({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  pix_fmt: z.string().optional(),
  channels: z.number().optional(),
  height: z.number().optional(),
  avg_frame_rate: z.string().optional(),
  disposition: z.looseObject({ attached_pic: z.number().optional() }).optional(),
  /** La matriz de rotación de los videos verticales de celular. */
  side_data_list: z.array(z.looseObject({ rotation: z.number().optional() })).optional(),
});

/** ±90° o ±270°: el video se ve con el ancho y el alto cambiados. */
const isQuarterTurn = (stream: z.infer<typeof streamSchema>) =>
  stream.side_data_list?.some(
    (side) => side.rotation !== undefined && Math.abs(side.rotation) % 180 === 90,
  ) ?? false;

const ffprobeSchema = z.object({
  streams: z.array(streamSchema).default([]),
  format: z
    .looseObject({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      size: z.string().optional(),
    })
    .optional(),
});

const positiveNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Más que esto no es un video real: es la base de tiempo (p. ej. "1000/1"). */
const MAX_FRAME_RATE = 240;

/** "30000/1001" → 29,97. "0/0" (desconocida) o valores absurdos → null. */
export function parseFrameRate(value: string | undefined): number | null {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const rate = Number(match[1]) / Number(match[2]);
  return Number.isFinite(rate) && rate > 0 && rate <= MAX_FRAME_RATE ? rate : null;
}

/**
 * Parsea `ffprobe -print_format json -show_format -show_streams`.
 * Ignora las portadas (stream de video con `attached_pic`), que en un MP3 o
 * M4A aparecen como "video" pero no lo son.
 */
export function parseFfprobeOutput(json: unknown): MediaInfo {
  const data = ffprobeSchema.parse(json);
  const video = data.streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  const size = positiveNumber(data.format?.size);
  return {
    durationSeconds: positiveNumber(data.format?.duration),
    formatName: data.format?.format_name ?? null,
    sizeBytes: size === null ? null : Math.round(size),
    video:
      video?.codec_name && video.width && video.height
        ? {
            codec: video.codec_name,
            // Medidas como se ven: ffmpeg aplica la rotación antes de los filtros (`-vf`).
            width: isQuarterTurn(video) ? video.height : video.width,
            height: isQuarterTurn(video) ? video.width : video.height,
            pixFmt: video.pix_fmt ?? null,
            frameRate: parseFrameRate(video.avg_frame_rate),
          }
        : null,
    audio: audio?.codec_name ? { codec: audio.codec_name, channels: audio.channels ?? null } : null,
  };
}

export type Ffprobe = (filePath: string) => Promise<MediaInfo>;

export class FfprobeError extends Error {
  override name = 'FfprobeError';
}

export function createFfprobe(run: CommandRunner, ffprobePath: string): Ffprobe {
  return async (filePath) => {
    const result = await run(ffprobePath, buildFfprobeArgs(filePath), {
      timeoutMs: 30_000,
      maxOutputChars: 4 * 1024 * 1024,
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new FfprobeError(`ffprobe falló (${String(result.exitCode)}): ${result.stderr.trim()}`);
    }
    try {
      return parseFfprobeOutput(JSON.parse(result.stdout));
    } catch (error) {
      throw new FfprobeError(`Salida de ffprobe inválida: ${String(error)}`);
    }
  };
}
