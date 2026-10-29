import { describe, expect, it } from 'vitest';
import {
  buildRecodeArgs,
  buildSelftestArgs,
  createFfmpegProgressTracker,
  createFfmpegRunner,
  FfmpegError,
} from './ffmpeg.ts';
import type { StreamingRunner } from './process.ts';

describe('buildSelftestArgs', () => {
  it('genera video y audio sintéticos a velocidad real, en H.264 + AAC', () => {
    const args = buildSelftestArgs({ durationSeconds: 60, outputPath: 'S:\\tmp\\abc.mp4' });
    expect(args).toContain('-nostdin');
    expect(args.slice(args.indexOf('-progress'), args.indexOf('-progress') + 2)).toEqual([
      '-progress',
      'pipe:1',
    ]);
    expect(args.filter((arg) => arg === '-re')).toHaveLength(2);
    expect(args).toContain('testsrc2=size=1280x720:rate=30:duration=60');
    expect(args).toContain('sine=frequency=440:sample_rate=48000:duration=60');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    // -shortest retrasa el progreso varios segundos (ver comentario en buildSelftestArgs).
    expect(args).not.toContain('-shortest');
    // La salida va al final, como un único argumento (aunque tenga espacios).
    expect(args.at(-1)).toBe('S:\\tmp\\abc.mp4');
  });

  it('rechaza duraciones inválidas', () => {
    expect(() => buildSelftestArgs({ durationSeconds: 0, outputPath: 'x' })).toThrow(RangeError);
    expect(() => buildSelftestArgs({ durationSeconds: 2.5, outputPath: 'x' })).toThrow(RangeError);
  });
});

describe('buildRecodeArgs', () => {
  const args = buildRecodeArgs({ inputPath: 'T:\\in put.mp4', outputPath: 'T:\\out.mp4' });

  it('recodifica a H.264 8 bits + AAC, con índice al principio', () => {
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-ac') + 1]).toBe('2');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
  });

  it('el audio es opcional y la entrada/salida van como argumentos únicos', () => {
    expect(args).toContain('0:a:0?');
    expect(args[args.indexOf('-i') + 1]).toBe('T:\\in put.mp4');
    expect(args.at(-1)).toBe('T:\\out.mp4');
  });
});

/** Salida real de `ffmpeg -progress pipe:1` (recortada). */
const progressBlock = (outTimeUs: string, speed: string, progress: string) => [
  'frame=450',
  'fps=30.00',
  'bitrate=1234.5kbits/s',
  'total_size=2310144',
  `out_time_us=${outTimeUs}`,
  `out_time_ms=${outTimeUs}`,
  'out_time=00:00:15.000000',
  'dup_frames=0',
  'drop_frames=0',
  `speed=${speed}`,
  `progress=${progress}`,
];

describe('createFfmpegProgressTracker', () => {
  it('emite un snapshot por bloque con porcentaje, velocidad y ETA', () => {
    const tracker = createFfmpegProgressTracker(60);
    const snapshots = progressBlock('15000000', '1.00x', 'continue')
      .map((line) => tracker.push(line))
      .filter((s) => s !== null);
    expect(snapshots).toEqual([
      { outTimeSeconds: 15, percent: 25, speedRatio: 1, etaSeconds: 45, done: false },
    ]);
  });

  it('calcula la velocidad real entre bloques en vez del promedio acumulado de ffmpeg', () => {
    // Caso medido: ffmpeg informaba 0,1x mientras el video avanzaba a tiempo real.
    let clock = 0;
    const tracker = createFfmpegProgressTracker(60, () => clock);
    const feed = (outTimeUs: string, speed: string) => {
      let last = null;
      for (const line of progressBlock(outTimeUs, speed, 'continue')) {
        last = tracker.push(line) ?? last;
      }
      return last;
    };

    // Primer bloque: solo está el valor de ffmpeg.
    expect(feed('1000000', '0.1x')?.speedRatio).toBe(0.1);
    // 2 s de reloj después el video avanzó 2 s: tiempo real.
    clock += 2000;
    const second = feed('3000000', '0.2x');
    expect(second?.speedRatio).toBeCloseTo(1);
    expect(second?.etaSeconds).toBeCloseTo(57);
  });

  it('suaviza los saltos de velocidad', () => {
    let clock = 0;
    const tracker = createFfmpegProgressTracker(100, () => clock);
    const feed = (outTimeUs: string) => {
      let last = null;
      for (const line of progressBlock(outTimeUs, 'N/A', 'continue')) {
        last = tracker.push(line) ?? last;
      }
      return last;
    };
    feed('0');
    clock += 1000;
    feed('1000000'); // 1x
    clock += 1000;
    const spike = feed('5000000'); // instantáneo 4x
    // 0,3 × 4 + 0,7 × 1 = 1,9: no salta directo a 4x.
    expect(spike?.speedRatio).toBeCloseTo(1.9);
  });

  it('tolera N/A al inicio', () => {
    const tracker = createFfmpegProgressTracker(60);
    let last = null;
    for (const line of progressBlock('N/A', 'N/A', 'continue')) last = tracker.push(line) ?? last;
    expect(last).toEqual({
      outTimeSeconds: null,
      percent: null,
      speedRatio: null,
      etaSeconds: null,
      done: false,
    });
  });

  it('marca 100 % al recibir progress=end', () => {
    const tracker = createFfmpegProgressTracker(60);
    let last = null;
    for (const line of progressBlock('59980000', '1.01x', 'end')) last = tracker.push(line) ?? last;
    expect(last).toMatchObject({ percent: 100, etaSeconds: 0, done: true });
  });

  it('sin duración total no inventa porcentaje', () => {
    const tracker = createFfmpegProgressTracker(null);
    let last = null;
    for (const line of progressBlock('5000000', '2.0x', 'continue'))
      last = tracker.push(line) ?? last;
    expect(last).toMatchObject({
      outTimeSeconds: 5,
      percent: null,
      speedRatio: 2,
      etaSeconds: null,
    });
  });

  it('nunca supera 100 % aunque out_time pase la duración', () => {
    const tracker = createFfmpegProgressTracker(10);
    let last = null;
    for (const line of progressBlock('12000000', '1x', 'continue'))
      last = tracker.push(line) ?? last;
    expect(last?.percent).toBe(100);
  });
});

describe('createFfmpegRunner', () => {
  const fakeRun =
    (lines: string[], exitCode: number): StreamingRunner =>
    (_file, _args, options) => {
      for (const line of lines) options.onStdoutLine?.(line);
      return Promise.resolve({ exitCode, stderrTail: ['Error: algo'] });
    };

  it('reenvía el progreso y resuelve con código 0', async () => {
    const seen: (number | null)[] = [];
    const run = createFfmpegRunner(
      fakeRun(progressBlock('30000000', '1x', 'continue'), 0),
      'ff.exe',
    );
    await run([], {
      signal: new AbortController().signal,
      totalDurationSeconds: 60,
      onProgress: (p) => seen.push(p.percent),
    });
    expect(seen).toEqual([50]);
  });

  it('lanza FfmpegError con el final de stderr si el código no es 0', async () => {
    const run = createFfmpegRunner(fakeRun([], 1), 'ff.exe');
    const error = await run([], {
      signal: new AbortController().signal,
      totalDurationSeconds: null,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegError);
    expect((error as FfmpegError).stderrTail).toEqual(['Error: algo']);
  });
});
