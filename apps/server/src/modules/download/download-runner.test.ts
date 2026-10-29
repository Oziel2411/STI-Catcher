import type { JobProgress } from '@sti-catcher/shared';
import { describe, expect, it, vi } from 'vitest';
import { FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import type { Ffprobe, MediaInfo } from '../../adapters/ffprobe.ts';
import { UrlBlockedError } from '../../adapters/url-guard.ts';
import { YtdlpError } from '../../adapters/ytdlp.ts';
import type { Ytdlp } from '../../adapters/ytdlp.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobContext, JobRecord } from '../../jobs/types.ts';
import { createDownloadRunner } from './download-runner.ts';
import type { DownloadParams, DownloadRunnerDeps } from './download-runner.ts';

const JOB_ID = '00000000-0000-4000-8000-00000000000a';
const TMP = 'S:\\storage\\tmp';

const h264Media: MediaInfo = {
  durationSeconds: 19.02,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  sizeBytes: 742000,
  video: { codec: 'h264', width: 320, height: 240, pixFmt: 'yuv420p' },
  audio: { codec: 'aac', channels: 2 },
};

function setup(params: Partial<DownloadParams> = {}, overrides: Partial<DownloadRunnerDeps> = {}) {
  const download = vi.fn<Ytdlp['download']>((options) => {
    options.onInfo({
      title: 'Me at the zoo',
      durationSeconds: 19,
      site: 'Youtube',
      webpageUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      formatId: '133+140',
    });
    options.onProgress({
      phase: 'downloading',
      percent: 45,
      speedBytesPerSecond: 1000,
      etaSeconds: 3,
    });
    return Promise.resolve();
  });
  const runFfmpeg = vi.fn<FfmpegRunner>((_args, options) => {
    options.onProgress?.({
      outTimeSeconds: 9.5,
      percent: 50,
      speedRatio: 2,
      etaSeconds: 4.75,
      done: false,
    });
    return Promise.resolve();
  });
  const ffprobe = vi.fn<Ffprobe>(() => Promise.resolve(h264Media));
  const files = {
    fileSize: vi.fn(() => Promise.resolve(742000)),
    removeFile: vi.fn(() => Promise.resolve()),
  };
  const checkUrl = vi.fn(() => Promise.resolve());
  const deps: DownloadRunnerDeps = {
    ytdlp: { download },
    runFfmpeg,
    ffprobe,
    files,
    checkUrl,
    ...overrides,
  };

  const progress: JobProgress[] = [];
  const job = {
    id: JOB_ID,
    type: 'download',
    status: 'running',
    title: 'título provisorio',
    params: {
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      format: 'mp4',
      maxHeight: 360,
      videoMode: 'compat',
      ...params,
    },
  } as JobRecord;
  const context: JobContext = {
    job,
    signal: new AbortController().signal,
    tempDir: TMP,
    reportProgress: (p) => progress.push(p),
  };
  return {
    runner: createDownloadRunner(deps),
    context,
    progress,
    download,
    runFfmpeg,
    ffprobe,
    files,
    checkUrl,
  };
}

describe('createDownloadRunner', () => {
  it('MP4 compat: descarga a tmp/<id>.mp4 y devuelve los datos reales del archivo', async () => {
    const { runner, context, download, runFfmpeg, progress } = setup();
    const result = await runner.run(context);

    expect(download.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      format: 'mp4',
      maxHeight: 360,
      mode: 'compat',
      outputTemplate: `${TMP}\\${JOB_ID}.%(ext)s`,
    });
    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(progress[0]).toEqual({
      phase: 'downloading',
      percent: 45,
      speedBytesPerSecond: 1000,
      speedRatio: null,
      etaSeconds: 3,
    });
    expect(result).toEqual({
      output: { tempPath: `${TMP}\\${JOB_ID}.mp4`, extension: '.mp4' },
      metadata: {
        title: 'Me at the zoo',
        durationSeconds: 19.02,
        format: 'mp4',
        resolution: '320x240',
        videoCodec: 'h264',
        audioCodec: 'aac',
      },
    });
  });

  it('recode: recodifica con ffmpeg (con progreso) y borra la descarga original', async () => {
    const { runner, context, runFfmpeg, files, progress } = setup({
      videoMode: 'recode',
      maxHeight: 2160,
    });
    const result = await runner.run(context);

    const args = runFfmpeg.mock.calls[0]?.[0] ?? [];
    expect(args[args.indexOf('-i') + 1]).toBe(`${TMP}\\${JOB_ID}.mp4`);
    expect(args.at(-1)).toBe(`${TMP}\\${JOB_ID}.h264.mp4`);
    expect(runFfmpeg.mock.calls[0]?.[1].totalDurationSeconds).toBe(19.02);
    expect(progress.filter((p) => p.phase === 'converting').map((p) => p.percent)).toEqual([0, 50]);
    expect(files.removeFile).toHaveBeenCalledWith(`${TMP}\\${JOB_ID}.mp4`);
    expect(result.output).toEqual({ tempPath: `${TMP}\\${JOB_ID}.h264.mp4`, extension: '.mp4' });
  });

  it('MP3: el archivo esperado es tmp/<id>.mp3', async () => {
    const { runner, context, ffprobe } = setup({ format: 'mp3', maxHeight: null });
    ffprobe.mockResolvedValue({ ...h264Media, video: null, audio: { codec: 'mp3', channels: 2 } });
    const result = await runner.run(context);
    expect(result.output).toEqual({ tempPath: `${TMP}\\${JOB_ID}.mp3`, extension: '.mp3' });
    expect(result.metadata).toMatchObject({ format: 'mp3', resolution: null, audioCodec: 'mp3' });
  });

  it('un error de yt-dlp llega al usuario traducido', async () => {
    const { runner, context } = setup(
      {},
      {
        ytdlp: {
          download: () =>
            Promise.reject(
              new YtdlpError({ code: 'PRIVATE', message: 'El video es privado.' }, []),
            ),
        },
      },
    );
    const error = await runner.run(context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).message).toBe('El video es privado.');
  });

  it('una URL que ahora apunta a la red interna no se descarga', async () => {
    const { runner, context, download } = setup(
      {},
      { checkUrl: () => Promise.reject(new UrlBlockedError()) },
    );
    await expect(runner.run(context)).rejects.toBeInstanceOf(JobError);
    expect(download).not.toHaveBeenCalled();
  });

  it('si yt-dlp no dejó el archivo esperado, falla con un mensaje claro', async () => {
    const { runner, context } = setup(
      {},
      {
        files: {
          fileSize: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
          removeFile: vi.fn(),
        },
      },
    );
    await expect(runner.run(context)).rejects.toThrow(/sin generar el archivo/);
  });

  it('si la recodificación falla, el mensaje lo dice', async () => {
    const { runner, context } = setup(
      { videoMode: 'recode' },
      { runFfmpeg: () => Promise.reject(new FfmpegError(1, ['Conversion failed!'])) },
    );
    await expect(runner.run(context)).rejects.toThrow(/recodificar/);
  });

  it('si ffprobe falla, el archivo igual se entrega (sin datos técnicos)', async () => {
    const { runner, context } = setup(
      {},
      { ffprobe: () => Promise.reject(new Error('ffprobe roto')) },
    );
    const result = await runner.run(context);
    expect(result.metadata).toMatchObject({
      durationSeconds: 19,
      resolution: null,
      videoCodec: null,
    });
  });

  it('el abort pasa tal cual (la cola decide si es cancelado o interrumpido)', async () => {
    const reason = new Error('abort');
    const { runner, context } = setup({}, { ytdlp: { download: () => Promise.reject(reason) } });
    await expect(runner.run(context)).rejects.toBe(reason);
  });
});
