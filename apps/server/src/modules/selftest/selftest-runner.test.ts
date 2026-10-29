import type { JobProgress } from '@sti-catcher/shared';
import { describe, expect, it, vi } from 'vitest';
import { FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobContext, JobRecord } from '../../jobs/types.ts';
import { createSelftestRunner } from './selftest-runner.ts';

const job = {
  id: '00000000-0000-4000-8000-00000000000a',
  type: 'selftest',
  status: 'running',
  params: { durationSeconds: 10 },
} as JobRecord;

function context(overrides: Partial<JobContext> = {}) {
  const progress: JobProgress[] = [];
  const ctx: JobContext = {
    job,
    signal: new AbortController().signal,
    tempDir: 'S:\\tmp',
    reportProgress: (p) => progress.push(p),
    ...overrides,
  };
  return { ctx, progress };
}

const files = () => ({
  fileSize: vi.fn(() => Promise.resolve(1_000_000)),
  removeFile: vi.fn(() => Promise.resolve()),
});

describe('createSelftestRunner', () => {
  it('genera el video en tmp, reporta progreso, informa el tamaño y borra el archivo', async () => {
    const runFfmpeg = vi.fn<FfmpegRunner>((_args, options) => {
      options.onProgress?.({
        outTimeSeconds: 5,
        percent: 50,
        speedRatio: 1,
        etaSeconds: 5,
        done: false,
      });
      return Promise.resolve();
    });
    const fileOps = files();
    const { ctx, progress } = context();

    const result = await createSelftestRunner({ runFfmpeg, files: fileOps }).run(ctx);

    const args = runFfmpeg.mock.calls[0]?.[0] ?? [];
    expect(args.at(-1)).toBe(`S:\\tmp\\${job.id}.mp4`);
    expect(runFfmpeg.mock.calls[0]?.[1].totalDurationSeconds).toBe(10);
    expect(progress.map((p) => p.percent)).toEqual([0, 50]);
    expect(fileOps.removeFile).toHaveBeenCalledWith(`S:\\tmp\\${job.id}.mp4`);
    expect(result).toEqual({
      output: null,
      metadata: { sizeBytes: 1_000_000, durationSeconds: 10 },
    });
  });

  it('traduce un fallo de ffmpeg a un mensaje para el usuario', async () => {
    const runFfmpeg: FfmpegRunner = () => Promise.reject(new FfmpegError(1, ['Unknown encoder']));
    const error = await createSelftestRunner({ runFfmpeg, files: files() })
      .run(context().ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).cause).toBeInstanceOf(FfmpegError);
  });

  it('deja pasar el abort tal cual (la cola decide cancelado o interrumpido)', async () => {
    const reason = new Error('abort');
    const runFfmpeg: FfmpegRunner = () => Promise.reject(reason);
    await expect(
      createSelftestRunner({ runFfmpeg, files: files() }).run(context().ctx),
    ).rejects.toBe(reason);
  });

  it('rechaza parámetros inválidos', async () => {
    const { ctx } = context({ job: { ...job, params: { durationSeconds: -1 } } });
    await expect(
      createSelftestRunner({ runFfmpeg: vi.fn(), files: files() }).run(ctx),
    ).rejects.toBeInstanceOf(JobError);
  });
});
