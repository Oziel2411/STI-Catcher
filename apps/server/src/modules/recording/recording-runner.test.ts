import type { JobProgress } from '@sti-catcher/shared';
import { describe, expect, it, vi } from 'vitest';
import { readJsonFixture } from '../../../test/fixtures.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import { parseFfprobeOutput } from '../../adapters/ffprobe.ts';
import type { Ffprobe } from '../../adapters/ffprobe.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobContext, JobRecord } from '../../jobs/types.ts';
import { createRecordingRunner } from './recording-runner.ts';
import type { RecordingRunnerDeps } from './recording-runner.ts';

const RECORDING_ID = '00000000-0000-4000-8000-00000000000a';
const JOB_ID = '00000000-0000-4000-8000-00000000000b';
const chromeWebm = parseFfprobeOutput(readJsonFixture('ffprobe-mediarecorder-chrome-webm.json'));
const resultMp4 = parseFfprobeOutput(readJsonFixture('ffprobe-sample-mp4.json'));

function setup(overrides: Partial<RecordingRunnerDeps> = {}) {
  const runFfmpeg = vi.fn<FfmpegRunner>(() => Promise.resolve());
  const ffprobe = vi.fn<Ffprobe>((file) =>
    Promise.resolve(file.endsWith('.webm') ? chromeWebm : resultMp4),
  );
  const removeFile = vi.fn(() => Promise.resolve());
  const deps: RecordingRunnerDeps = {
    recordingsDir: 'S:\\storage\\recordings',
    ffprobe,
    runFfmpeg,
    removeFile,
    ...overrides,
  };
  const progress: JobProgress[] = [];
  const context: JobContext = {
    job: {
      id: JOB_ID,
      type: 'recording',
      status: 'running',
      params: { recordingId: RECORDING_ID, extension: 'webm', fps: 30, estimatedSeconds: 120 },
    } as JobRecord,
    signal: new AbortController().signal,
    tempDir: 'S:\\storage\\tmp',
    reportProgress: (p) => progress.push(p),
  };
  return { runner: createRecordingRunner(deps), context, runFfmpeg, removeFile, progress };
}

describe('createRecordingRunner', () => {
  it('procesa el crudo a MP4, usa la duración estimada (el WebM no la trae) y borra el crudo', async () => {
    const { runner, context, runFfmpeg, removeFile } = setup();
    const result = await runner.run(context);
    const args = runFfmpeg.mock.calls[0]?.[0] ?? [];
    expect(args[args.indexOf('-i') + 1]).toBe(`S:\\storage\\recordings\\${RECORDING_ID}.webm`);
    expect(args.at(-1)).toBe(`S:\\storage\\tmp\\${JOB_ID}.mp4`);
    expect(runFfmpeg.mock.calls[0]?.[1].totalDurationSeconds).toBe(120);
    expect(removeFile).toHaveBeenCalledWith(`S:\\storage\\recordings\\${RECORDING_ID}.webm`);
    expect(result.output).toEqual({
      tempPath: `S:\\storage\\tmp\\${JOB_ID}.mp4`,
      extension: '.mp4',
    });
    expect(result.metadata).toMatchObject({ format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' });
  });

  it('si el procesamiento falla, el crudo se conserva para reintentar', async () => {
    const { FfmpegError } = await import('../../adapters/ffmpeg.ts');
    const { runner, context, removeFile } = setup({
      runFfmpeg: () => Promise.reject(new FfmpegError(1, ['Invalid data'])),
    });
    await expect(runner.run(context)).rejects.toBeInstanceOf(JobError);
    expect(removeFile).not.toHaveBeenCalled();
  });

  it('si el crudo no existe o no tiene video, un mensaje claro', async () => {
    const { runner, context } = setup({ ffprobe: () => Promise.reject(new Error('no existe')) });
    await expect(runner.run(context)).rejects.toThrow(/no se puede leer/);
  });
});
