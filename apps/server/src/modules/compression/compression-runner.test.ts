import type { JobProgress, ResolvedEncoders } from '@sti-catcher/shared';
import { describe, expect, it, vi } from 'vitest';
import { readJsonFixture } from '../../../test/fixtures.ts';
import { FfmpegError } from '../../adapters/ffmpeg.ts';
import type { FfmpegRunner } from '../../adapters/ffmpeg.ts';
import { parseFfprobeOutput } from '../../adapters/ffprobe.ts';
import type { Ffprobe } from '../../adapters/ffprobe.ts';
import { createEncoderRegistry } from '../../adapters/video-encoders.ts';
import { JobError } from '../../jobs/errors.ts';
import type { JobContext, JobRecord } from '../../jobs/types.ts';
import { createCompressionRunner } from './compression-runner.ts';
import type { CompressionRunnerDeps } from './compression-runner.ts';

const SOURCE_ID = '00000000-0000-4000-8000-00000000000a';
const JOB_ID = '00000000-0000-4000-8000-00000000000b';
const STORAGE = 'S:\\storage';
const MB = 1024 * 1024;
/** MOV HEVC 1080p de 12 s con audio (fixture real). */
const iphone = parseFfprobeOutput(readJsonFixture('ffprobe-iphone-hevc-mov.json'));

function setup(
  params: object,
  {
    resolved = { h264: 'qsv', hevc: 'qsv' },
    sizes = [5 * MB],
    failWith = [] as string[],
    ...overrides
  }: Partial<CompressionRunnerDeps> & {
    resolved?: ResolvedEncoders;
    /** Tamaño de la salida en cada intento. */
    sizes?: number[];
    /** Encoders con los que ffmpeg falla. */
    failWith?: string[];
  } = {},
) {
  const source = { id: SOURCE_ID, status: 'done', filePath: `files/${SOURCE_ID}.mov` } as JobRecord;
  const ffprobe = vi.fn<Ffprobe>(() => Promise.resolve(iphone));
  const runFfmpeg = vi.fn<FfmpegRunner>((args, options) => {
    const encoder = args[args.indexOf('-c:v') + 1] ?? '';
    if (failWith.includes(encoder)) {
      return Promise.reject(new FfmpegError(1, ['Error while opening encoder']));
    }
    options.onProgress?.({
      outTimeSeconds: 6,
      percent: 50,
      speedRatio: 2,
      etaSeconds: 3,
      done: false,
    });
    return Promise.resolve();
  });
  let attempt = 0;
  const fileSize = vi.fn(() => Promise.resolve(sizes[Math.min(attempt++, sizes.length - 1)] ?? 0));
  const registry = createEncoderRegistry(Promise.resolve(resolved));
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps: CompressionRunnerDeps = {
    getJob: (id) => (id === SOURCE_ID ? source : null),
    storageDir: STORAGE,
    filesDir: `${STORAGE}\\files`,
    ffprobe,
    runFfmpeg,
    encoders: registry,
    fileSize,
    logger,
    ...overrides,
  };
  const progress: JobProgress[] = [];
  const context: JobContext = {
    job: { id: JOB_ID, type: 'compression', status: 'running', params } as JobRecord,
    signal: new AbortController().signal,
    tempDir: `${STORAGE}\\tmp`,
    reportProgress: (p) => progress.push(p),
  };
  const encodersUsed = () => runFfmpeg.mock.calls.map(([args]) => args[args.indexOf('-c:v') + 1]);
  return {
    runner: createCompressionRunner(deps),
    context,
    progress,
    runFfmpeg,
    registry,
    encodersUsed,
  };
}

const quality = { sourceJobId: SOURCE_ID, options: { preset: 'fast-720p' } };
const toSize = (megabytes: number) => ({
  sourceJobId: SOURCE_ID,
  options: { preset: 'share-720p', target: { mode: 'size', megabytes } },
});

describe('createCompressionRunner', () => {
  it('comprime el origen a tmp/<id>.mp4 con prioridad baja y datos reales', async () => {
    const { runner, context, runFfmpeg, progress } = setup(quality);
    const result = await runner.run(context);

    const [args, options] = runFfmpeg.mock.calls[0] ?? [];
    expect(args?.[args.indexOf('-i') + 1]).toBe(`${STORAGE}\\files\\${SOURCE_ID}.mov`);
    expect(args?.at(-1)).toBe(`${STORAGE}\\tmp\\${JOB_ID}.mp4`);
    expect(args?.[args.indexOf('-c:v') + 1]).toBe('h264_qsv');
    expect(options?.lowPriority).toBe(true);
    expect(progress.map((p) => p.percent)).toEqual([0, 50]);
    expect(result.output).toEqual({
      tempPath: `${STORAGE}\\tmp\\${JOB_ID}.mp4`,
      extension: '.mp4',
    });
    expect(result.metadata).toMatchObject({ format: 'mp4', resolution: '1920x1080' });
  });

  it('dos pasadas (CPU con tamaño): el progreso va de 0 a 50 y de 50 a 100', async () => {
    const { runner, context, runFfmpeg, progress } = setup(toSize(5), {
      resolved: { h264: 'cpu', hevc: 'cpu' },
    });
    await runner.run(context);
    expect(runFfmpeg).toHaveBeenCalledTimes(2);
    const passes = runFfmpeg.mock.calls.map(([args]) => args[args.indexOf('-pass') + 1]);
    expect(passes).toEqual(['1', '2']);
    expect(progress.map((p) => p.percent)).toEqual([0, 25, 75]);
    // El tiempo restante de la primera pasada suma la segunda entera (12 s a 2×).
    expect(progress[1]?.etaSeconds).toBe(3 + 6);
  });

  it('la GPU falla: repite por CPU y deja ese códec en CPU para los siguientes', async () => {
    const { runner, context, registry, encodersUsed } = setup(quality, { failWith: ['h264_qsv'] });
    await runner.run(context);
    expect(encodersUsed()).toEqual(['h264_qsv', 'libx264']);
    await expect(registry.current()).resolves.toEqual({ h264: 'cpu', hevc: 'qsv' });
  });

  it('con tamaño objetivo se pasó: repite más bajo una vez', async () => {
    const { runner, context, runFfmpeg } = setup(toSize(5), { sizes: [5.6 * MB, 4.8 * MB] });
    await runner.run(context);
    const rates = runFfmpeg.mock.calls.map(([args]) =>
      Number.parseInt(args[args.indexOf('-b:v') + 1] ?? ''),
    );
    expect(rates).toHaveLength(2);
    expect(rates[1]).toBeLessThan(rates[0] ?? 0);
  });

  it('si después del reintento sigue pasado, falla con el motivo', async () => {
    const { runner, context } = setup(toSize(5), { sizes: [5.6 * MB, 5.2 * MB] });
    await expect(runner.run(context)).rejects.toThrow(
      /No se llegó al tamaño pedido: salió de 5,2 MB/,
    );
  });

  it('con la CPU, un error de ffmpeg es un JobError genérico (el detalle va al log)', async () => {
    const { runner, context } = setup(quality, {
      resolved: { h264: 'cpu', hevc: 'cpu' },
      failWith: ['libx264'],
    });
    await expect(runner.run(context)).rejects.toThrow(JobError);
  });

  it('el origen desapareció mientras esperaba en la cola', async () => {
    const { runner, context } = setup(quality, { getJob: () => null });
    await expect(runner.run(context)).rejects.toThrow(
      'El archivo de origen ya no está disponible.',
    );
  });

  it('parámetros inválidos', async () => {
    const { runner, context } = setup({ sourceJobId: SOURCE_ID, options: { preset: 'x' } });
    await expect(runner.run(context)).rejects.toThrow('Parámetros inválidos para la compresión.');
  });
});
