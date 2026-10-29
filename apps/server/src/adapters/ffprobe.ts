import { z } from 'zod';
import type { CommandRunner } from './process.ts';

export type MediaInfo = {
  durationSeconds: number | null;
  /** Nombre del contenedor según ffprobe, p. ej. "mov,mp4,m4a,3gp,3g2,mj2". */
  formatName: string | null;
  sizeBytes: number | null;
  video: { codec: string; width: number; height: number; pixFmt: string | null } | null;
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
  disposition: z.looseObject({ attached_pic: z.number().optional() }).optional(),
});

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
            width: video.width,
            height: video.height,
            pixFmt: video.pix_fmt ?? null,
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
