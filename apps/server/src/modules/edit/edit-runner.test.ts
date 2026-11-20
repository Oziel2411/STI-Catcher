import type { JobProgress } from '@sti-catcher/shared';
import { describe, expect, it, vi } from 'vitest';
import { readJsonFixture } from '../../../test/fixtures.ts';
import { FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import { parseFfprobeOutput } from '../../adapters/ffprobe.ts';
import type { Ffprobe, MediaInfo } from '../../adapters/ffprobe.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobContext, JobRecord } from '../../jobs/types.ts';
import { createEditRunner } from './edit-runner.ts';

const SOURCE_ID = '00000000-0000-4000-8000-00000000000a';
const JOB_ID = '00000000-0000-4000-8000-00000000000b';
const STORAGE = 'S:\\storage';
const recording = parseFfprobeOutput(readJsonFixture('ffprobe-mediarecorder-chrome-mp4.json'));

function setup(
  params: object,
  {
    source = { id: SOURCE_ID, status: 'done', filePath: `files/${SOURCE_ID}.mp4` } as JobRecord,
    media = recording,
    fail = false,
  }: { source?: JobRecord | null; media?: MediaInfo | null; fail?: boolean } = {},
) {
  const ffprobe = vi.fn<Ffprobe>(() =>
    media === null ? Promise.reject(new Error('no')) : Promise.resolve(media),
  );
  const runFfmpeg = vi.fn<FfmpegRunner>((_args, options) => {
    if (fail) return Promise.reject(new FfmpegError(1, ['Invalid data']));
    options.onProgress?.({
      outTimeSeconds: 2,
      percent: 50,
      speedRatio: 4,
      etaSeconds: 1,
      done: false,
    });
    return Promise.resolve();
  });
  const writeTextFile = vi.fn(() => Promise.resolve());
  const runner = createEditRunner({
    getJob: (id) => (id === SOURCE_ID ? source : null),
    storageDir: STORAGE,
    filesDir: `${STORAGE}\\files`,
    ffprobe,
    runFfmpeg,
    writeTextFile,
  });
  const progress: JobProgress[] = [];
  const context: JobContext = {
    job: { id: JOB_ID, type: 'edit', status: 'running', params } as JobRecord,
    signal: new AbortController().signal,
    tempDir: `${STORAGE}\\tmp`,
    reportProgress: (p) => progress.push(p),
  };
  return { runner, context, progress, runFfmpeg, writeTextFile };
}

const params = (segments: object[], precision = 'exact') => ({
  sourceJobId: SOURCE_ID,
  segments,
  precision,
});

describe('createEditRunner', () => {
  it('recorta el origen a tmp/<id>.mp4 con prioridad baja y la duración del tramo', async () => {
    const { runner, context, runFfmpeg, progress, writeTextFile } = setup(
      params([{ start: 1, end: 3 }]),
    );
    const result = await runner.run(context);

    const [args, options] = runFfmpeg.mock.calls[0] ?? [];
    expect(args?.[args.indexOf('-i') + 1]).toBe(`${STORAGE}\\files\\${SOURCE_ID}.mp4`);
    expect(args?.at(-1)).toBe(`${STORAGE}\\tmp\\${JOB_ID}.mp4`);
    expect(options?.lowPriority).toBe(true);
    expect(options?.totalDurationSeconds).toBe(2);
    expect(progress.map((p) => [p.phase, p.percent])).toEqual([
      ['processing', 0],
      ['processing', 50],
    ]);
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(result.output).toEqual({
      tempPath: `${STORAGE}\\tmp\\${JOB_ID}.mp4`,
      extension: '.mp4',
    });
    expect(result.metadata).toMatchObject({ format: 'mp4', videoCodec: 'h264' });
  });

  it('rápido con varios tramos: escribe la lista concat en tmp con el id del job', async () => {
    const { runner, context, writeTextFile } = setup(
      params(
        [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
        ],
        'fast',
      ),
    );
    await runner.run(context);
    expect(writeTextFile).toHaveBeenCalledWith(
      `${STORAGE}\\tmp\\${JOB_ID}-list.txt`,
      expect.stringContaining('inpoint 2'),
    );
  });

  it('el origen ya no está: falla con un mensaje para el usuario', async () => {
    const { runner, context, runFfmpeg } = setup(params([{ start: 0, end: 1 }]), {
      source: null,
    });
    await expect(runner.run(context)).rejects.toThrow('El archivo de origen ya no está');
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it('parámetros que no cumplen el esquema: JobError', async () => {
    const { runner, context } = setup(params([{ start: 3, end: 1 }]));
    await expect(runner.run(context)).rejects.toThrow(JobError);
  });

  it('ffmpeg falla: JobError sin detalles internos', async () => {
    const { runner, context } = setup(params([{ start: 0, end: 1 }]), { fail: true });
    await expect(runner.run(context)).rejects.toThrow('ffmpeg no pudo recortar el video');
  });
});
