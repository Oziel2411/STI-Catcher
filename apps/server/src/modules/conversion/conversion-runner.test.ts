import type { JobProgress } from '@sti-catcher/shared';
import { describe, expect, it, vi } from 'vitest';
import { FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import type { Ffprobe, MediaInfo } from '../../adapters/ffprobe.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobContext, JobRecord } from '../../jobs/types.ts';
import { createConversionRunner } from './conversion-runner.ts';
import type { ConversionRunnerDeps } from './conversion-runner.ts';

const SOURCE_ID = '00000000-0000-4000-8000-00000000000a';
const JOB_ID = '00000000-0000-4000-8000-00000000000b';
const STORAGE = 'S:\\storage';

const hevcMov: MediaInfo = {
  durationSeconds: 12,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  sizeBytes: 5_000_000,
  video: { codec: 'hevc', width: 1920, height: 1080, pixFmt: 'yuv420p' },
  audio: { codec: 'aac', channels: 2 },
};

function setup(params: object, overrides: Partial<ConversionRunnerDeps> = {}) {
  const source = { id: SOURCE_ID, status: 'done', filePath: `files/${SOURCE_ID}.mov` } as JobRecord;
  const ffprobe = vi.fn<Ffprobe>((file) =>
    Promise.resolve(
      file.endsWith('.mov')
        ? hevcMov
        : { ...hevcMov, video: { codec: 'h264', width: 1920, height: 1080, pixFmt: 'yuv420p' } },
    ),
  );
  const runFfmpeg = vi.fn<FfmpegRunner>((_args, options) => {
    options.onProgress?.({
      outTimeSeconds: 6,
      percent: 50,
      speedRatio: 3,
      etaSeconds: 2,
      done: false,
    });
    return Promise.resolve();
  });
  const deps: ConversionRunnerDeps = {
    getJob: (id) => (id === SOURCE_ID ? source : null),
    storageDir: STORAGE,
    filesDir: `${STORAGE}\\files`,
    ffprobe,
    runFfmpeg,
    ...overrides,
  };
  const progress: JobProgress[] = [];
  const context: JobContext = {
    job: { id: JOB_ID, type: 'conversion', status: 'running', params } as JobRecord,
    signal: new AbortController().signal,
    tempDir: `${STORAGE}\\tmp`,
    reportProgress: (p) => progress.push(p),
  };
  return { runner: createConversionRunner(deps), context, progress, runFfmpeg, ffprobe };
}

describe('createConversionRunner', () => {
  it('convierte el archivo del origen a tmp/<id>.<ext> con progreso y datos reales', async () => {
    const { runner, context, runFfmpeg, progress } = setup({
      sourceJobId: SOURCE_ID,
      preset: 'mp4',
      maxHeight: null,
    });
    const result = await runner.run(context);

    const args = runFfmpeg.mock.calls[0]?.[0] ?? [];
    expect(args[args.indexOf('-i') + 1]).toBe(`${STORAGE}\\files\\${SOURCE_ID}.mov`);
    expect(args.at(-1)).toBe(`${STORAGE}\\tmp\\${JOB_ID}.mp4`);
    expect(runFfmpeg.mock.calls[0]?.[1].totalDurationSeconds).toBe(12);
    expect(progress.map((p) => [p.phase, p.percent])).toEqual([
      ['converting', 0],
      ['converting', 50],
    ]);
    expect(result).toEqual({
      output: { tempPath: `${STORAGE}\\tmp\\${JOB_ID}.mp4`, extension: '.mp4' },
      metadata: {
        format: 'mp4',
        durationSeconds: 12,
        resolution: '1920x1080',
        videoCodec: 'h264',
        audioCodec: 'aac',
      },
    });
  });

  it('GIF: la duración del progreso es la del fragmento', async () => {
    const { runner, context, runFfmpeg } = setup({
      sourceJobId: SOURCE_ID,
      preset: 'gif',
      maxHeight: null,
      gif: { startSeconds: 1, endSeconds: 4, fps: 10, width: 480 },
    });
    await runner.run(context);
    expect(runFfmpeg.mock.calls[0]?.[1].totalDurationSeconds).toBe(3);
  });

  it('si el origen ya no está (expiró o lo borraron), falla con un mensaje claro', async () => {
    const { runner, context } = setup(
      { sourceJobId: SOURCE_ID, preset: 'mp3', maxHeight: null },
      { getJob: () => null },
    );
    await expect(runner.run(context)).rejects.toThrow(
      'El archivo de origen ya no está disponible.',
    );
  });

  it('un error de ffmpeg llega como JobError', async () => {
    const { runner, context } = setup(
      { sourceJobId: SOURCE_ID, preset: 'webm', maxHeight: null },
      { runFfmpeg: () => Promise.reject(new FfmpegError(1, ['Conversion failed!'])) },
    );
    await expect(runner.run(context)).rejects.toBeInstanceOf(JobError);
  });

  it('parámetros inválidos (p. ej. un preset que no existe)', async () => {
    const { runner, context } = setup({ sourceJobId: SOURCE_ID, preset: 'flv', maxHeight: null });
    await expect(runner.run(context)).rejects.toThrow(/Parámetros inválidos/);
  });
});
