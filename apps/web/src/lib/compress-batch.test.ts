import { compressionOptionsSchema } from '@sti-catcher/shared';
import type { CompressionSourceResponse, Job } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import {
  applyOptionsToAll,
  estimateText,
  heightOptions,
  isCompressible,
  itemProblem,
  newHistoryItem,
  newUploadItem,
  optionsTag,
  restoreBatch,
  savingText,
  serializeBatch,
  withSource,
} from './compress-batch.ts';
import type { CompressItem } from './compress-batch.ts';

const MB = 1024 * 1024;
const ids = {
  a: '00000000-0000-4000-8000-00000000000a',
  b: '00000000-0000-4000-8000-00000000000b',
};

const job = (patch: Partial<Job> = {}): Job => ({
  id: ids.a,
  type: 'upload',
  status: 'done',
  title: 'reunion.mp4',
  sourceUrl: null,
  createdAt: '2026-11-16T12:00:00.000Z',
  startedAt: null,
  finishedAt: '2026-11-16T12:00:01.000Z',
  error: null,
  sizeBytes: 419 * MB,
  durationSeconds: 2006,
  format: 'mp4',
  resolution: '1920x1080',
  videoCodec: 'h264',
  audioCodec: 'aac',
  parentJobId: null,
  followUpJobId: null,
  progress: null,
  ...patch,
});

/** Como lo devuelve GET /api/compression/sources/:id para el MP4 real de 33 min (D-108). */
const source = (
  patch: Partial<CompressionSourceResponse['media']> = {},
  jobPatch: Partial<Job> = {},
) =>
  ({
    job: job(jobPatch),
    media: {
      hasVideo: true,
      hasAudio: true,
      durationSeconds: 2006.7,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      frameRate: 30,
      sizeBytes: 419 * MB,
      ...patch,
    },
    encoders: { h264: 'qsv', hevc: 'qsv' },
  }) satisfies CompressionSourceResponse;

const ready = (options: unknown = { preset: 'share-720p' }, src = source()): CompressItem => ({
  ...withSource(newHistoryItem('i1', ids.a), src),
  options: compressionOptionsSchema.parse(options),
});

describe('withSource', () => {
  it('un archivo cualquiera arranca con «Para compartir»; una grabación, con su preset', () => {
    expect(withSource(newHistoryItem('i', ids.a), source()).options.preset).toBe('share-720p');
    expect(
      withSource(newHistoryItem('i', ids.a), source({}, { type: 'recording' })).options.preset,
    ).toBe('screen');
  });

  it('si ya estaba analizado (recarga), conserva lo elegido', () => {
    const chosen = ready({ preset: 'archive-1080p' });
    expect(withSource({ ...chosen, status: 'analyzing' }, source()).options.preset).toBe(
      'archive-1080p',
    );
  });
});

describe('itemProblem / isCompressible', () => {
  it('calidad constante: siempre se puede', () => {
    expect(itemProblem(ready())).toBeNull();
    expect(isCompressible(ready())).toBe(true);
  });

  it('33 min en 24 MB no alcanza: el mismo motivo que daría el server', () => {
    const item = ready({ preset: 'share-720p', target: { mode: 'size', megabytes: 24 } });
    expect(itemProblem(item)).toMatch(/Es demasiado largo para que entre en 24 MB/);
    expect(isCompressible(item)).toBe(false);
  });

  it('un original más chico que lo pedido no tiene problema (se comprime con calidad)', () => {
    const small = ready(
      { preset: 'share-720p', target: { mode: 'size', megabytes: 5 } },
      source({ durationSeconds: 3600, sizeBytes: 0.7 * MB }),
    );
    expect(itemProblem(small)).toBeNull();
  });

  it('subiendo o analizando, todavía no', () => {
    expect(isCompressible(newUploadItem('u', { name: 'a.mp4', size: 10 }))).toBe(false);
  });
});

describe('estimateText', () => {
  it('tamaño objetivo: «hasta N MB»', () => {
    const item = ready({ preset: 'share-720p', target: { mode: 'size', megabytes: 250 } });
    expect(estimateText(item)).toEqual({ text: 'hasta 250 MB', mayNotShrink: false });
  });

  it('calidad constante: un rango que nunca supera al original', () => {
    const estimate = estimateText(ready({ preset: 'archive-original' }));
    expect(estimate?.text).toMatch(/^≈ .+ a 419 MB$/);
    expect(estimate?.mayNotShrink).toBe(true);
    expect(estimateText(ready({ preset: 'share-720p' }))?.mayNotShrink).toBe(false);
  });
});

describe('heightOptions', () => {
  it('solo alturas por debajo de lo que ya deja el preset', () => {
    expect(heightOptions(ready({ preset: 'share-720p' }))).toEqual([480, 360, 240]);
    expect(heightOptions(ready({ preset: 'archive-original' }))).toEqual([720, 480, 360, 240]);
  });
});

describe('optionsTag', () => {
  it('preset, altura y tamaño', () => {
    expect(
      optionsTag(
        compressionOptionsSchema.parse({
          preset: 'share-720p',
          maxHeight: 480,
          target: { mode: 'size', megabytes: 24.5 },
        }),
      ),
    ).toBe('Para compartir 720p · 480p · hasta 24,5 MB');
  });
});

describe('applyOptionsToAll', () => {
  it('copia preset, modo y audio; la altura solo donde baja', () => {
    const from = { ...ready({ preset: 'archive-1080p', audioKbps: 64, maxHeight: 720 }), id: 'a' };
    const small = { ...ready(undefined, source({ height: 480, width: 854 })), id: 'b' };
    const big = { ...ready(), id: 'c' };
    const result = applyOptionsToAll([from, small, big], 'a');
    expect(result[1]?.options).toMatchObject({
      preset: 'archive-1080p',
      audioKbps: 64,
      maxHeight: null,
    });
    expect(result[2]?.options).toMatchObject({ preset: 'archive-1080p', maxHeight: 720 });
  });
});

describe('savingText', () => {
  it('cuánto achicó, o cuánto creció', () => {
    expect(savingText(419 * MB, 107 * MB)).toBe('de 419 MB a 107 MB (−74 %)');
    expect(savingText(10 * MB, 11 * MB)).toBe('de 10 MB a 11 MB (+10 %)');
    expect(savingText(null, 1)).toBeNull();
  });
});

describe('sessionStorage', () => {
  it('guarda sin lo que se estaba subiendo y los listos vuelven a analizarse', () => {
    const items = [ready(), newUploadItem('u', { name: 'b.mp4', size: 5 })];
    const restored = restoreBatch(serializeBatch(items));
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ status: 'analyzing', options: items[0]?.options });
    expect(restoreBatch('{basura')).toEqual([]);
  });
});
