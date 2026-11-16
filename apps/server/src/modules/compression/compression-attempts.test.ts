import { compressionOptionsSchema } from '@sti-catcher/shared';
import type { CompressionSource } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import { firstAttempt, nextAttempt } from './compression-attempts.ts';
import type { Attempt } from './compression-attempts.ts';

const MB = 1024 * 1024;
const source: CompressionSource = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  durationSeconds: 120,
  hasAudio: true,
};
const quality = compressionOptionsSchema.parse({ preset: 'fast-720p' });
const toSize = (megabytes: number) =>
  compressionOptionsSchema.parse({ preset: 'share-720p', target: { mode: 'size', megabytes } });
const gpu = { h264: 'qsv', hevc: 'qsv' } as const;
const cpu = { h264: 'cpu', hevc: 'cpu' } as const;

const first = (options = quality, encoders: typeof gpu | typeof cpu = gpu): Attempt => {
  const attempt = firstAttempt(source, options, encoders);
  if ('error' in attempt) throw new Error(attempt.error);
  return attempt;
};

describe('firstAttempt', () => {
  it('calidad constante: sin bitrate, con el encoder del códec del preset', () => {
    expect(first()).toEqual({ number: 1, encoder: 'qsv', videoKbps: null, sizeRetried: false });
    const hevc = firstAttempt(source, compressionOptionsSchema.parse({ preset: 'archive-1080p' }), {
      h264: 'qsv',
      hevc: 'cpu',
    });
    expect(hevc).toMatchObject({ encoder: 'cpu' });
  });

  it('tamaño objetivo: el bitrate depende del margen de cada encoder', () => {
    const onGpu = first(toSize(24), gpu);
    const onCpu = first(toSize(24), cpu);
    expect(onGpu.videoKbps).toBeGreaterThan(0);
    expect(onCpu.videoKbps).toBeGreaterThan(onGpu.videoKbps ?? Infinity);
  });

  it('un tamaño al que no se llega devuelve el motivo para el usuario', () => {
    expect(firstAttempt({ ...source, durationSeconds: 3600 }, toSize(5), gpu)).toEqual({
      error: expect.stringMatching(/Es demasiado largo para que entre en 5 MB/) as unknown,
    });
    expect(firstAttempt({ ...source, durationSeconds: null }, toSize(24), gpu)).toEqual({
      error: expect.stringMatching(/No se sabe cuánto dura/) as unknown,
    });
  });
});

describe('original más chico que el tamaño pedido (no se infla)', () => {
  // La grabación real de 0,7 MB que con 5 MB de objetivo había salido de 4,3 MB.
  const small: CompressionSource = { ...source, durationSeconds: 19, sizeBytes: 0.7 * MB };

  it('primero, la calidad del preset', () => {
    expect(firstAttempt(small, toSize(5), gpu)).toEqual({
      number: 1,
      encoder: 'qsv',
      videoKbps: null,
      sizeRetried: false,
    });
  });

  it('si con la calidad del preset se pasa, ahí sí apunta al tamaño (una vez)', () => {
    const qualityFirst: Attempt = {
      number: 1,
      encoder: 'qsv',
      videoKbps: null,
      sizeRetried: false,
    };
    const decision = nextAttempt(small, toSize(5), qualityFirst, {
      kind: 'encoded',
      sizeBytes: 5.5 * MB,
    });
    expect(decision).toMatchObject({
      kind: 'retry',
      reason: 'too-big',
      attempt: { number: 2, sizeRetried: true },
    });
    if (decision.kind === 'retry') expect(decision.attempt.videoKbps).toBeGreaterThan(0);
  });
});

describe('nextAttempt', () => {
  it('calidad constante: terminó, aunque haya salido más grande que el original', () => {
    expect(nextAttempt(source, quality, first(), { kind: 'encoded', sizeBytes: 999 * MB })).toEqual(
      { kind: 'done' },
    );
  });

  it('la GPU falló: se repite por CPU, recalculando el bitrate con el margen de la CPU', () => {
    const attempt = first(toSize(24), gpu);
    const decision = nextAttempt(source, toSize(24), attempt, { kind: 'gpu-failed' });
    expect(decision).toEqual({
      kind: 'retry',
      reason: 'gpu-failed',
      attempt: {
        number: 2,
        encoder: 'cpu',
        videoKbps: first(toSize(24), cpu).videoKbps,
        sizeRetried: false,
      },
    });
  });

  it('la CPU falló: no hay a qué volver', () => {
    expect(nextAttempt(source, quality, first(quality, cpu), { kind: 'gpu-failed' })).toMatchObject(
      {
        kind: 'fail',
      },
    );
  });

  it('tamaño objetivo cumplido: terminó', () => {
    const decision = nextAttempt(source, toSize(24), first(toSize(24)), {
      kind: 'encoded',
      sizeBytes: 23.9 * MB,
    });
    expect(decision).toEqual({ kind: 'done' });
  });

  it('se pasó del tamaño: un reintento más bajo con el mismo encoder; si se vuelve a pasar, falla', () => {
    const attempt = first(toSize(24));
    const decision = nextAttempt(source, toSize(24), attempt, {
      kind: 'encoded',
      sizeBytes: 26.4 * MB,
    });
    expect(decision).toMatchObject({ kind: 'retry', reason: 'too-big' });
    if (decision.kind !== 'retry') return;
    expect(decision.attempt.encoder).toBe('qsv');
    expect(decision.attempt.sizeRetried).toBe(true);
    expect(decision.attempt.videoKbps).toBeLessThan(attempt.videoKbps ?? 0);

    const again = nextAttempt(source, toSize(24), decision.attempt, {
      kind: 'encoded',
      sizeBytes: 24.5 * MB,
    });
    expect(again).toEqual({
      kind: 'fail',
      message:
        'No se llegó al tamaño pedido: salió de 24,5 MB y el máximo era 24,0 MB. Probá una resolución más baja o un tamaño mayor.',
    });
  });

  it('después de caer a CPU todavía se permite el reintento por tamaño', () => {
    const fallback = nextAttempt(source, toSize(24), first(toSize(24)), { kind: 'gpu-failed' });
    if (fallback.kind !== 'retry') throw new Error('esperaba reintento');
    expect(
      nextAttempt(source, toSize(24), fallback.attempt, { kind: 'encoded', sizeBytes: 25 * MB }),
    ).toMatchObject({ kind: 'retry', reason: 'too-big', attempt: { number: 3, encoder: 'cpu' } });
  });

  it('si el reintento quedaría por debajo del piso de calidad, falla en vez de romper la imagen', () => {
    // Al límite de lo posible y muy pasado: bajar más rompería la imagen.
    const tight = toSize(13);
    const attempt = first(tight);
    expect(
      nextAttempt(source, tight, attempt, { kind: 'encoded', sizeBytes: 40 * MB }),
    ).toMatchObject({
      kind: 'fail',
      message: expect.stringMatching(/sin romper la imagen/) as unknown,
    });
  });
});
