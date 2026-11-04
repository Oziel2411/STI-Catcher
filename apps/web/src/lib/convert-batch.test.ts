import type { ConversionSourceResponse, GifLimits, Job, SourceMedia } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import {
  applyEventToItems,
  applyFormatToAll,
  formatTag,
  isConvertible,
  itemMeta,
  newHistoryItem,
  newUploadItem,
  parseOrigin,
  restoreBatch,
  serializeBatch,
  withSource,
} from './convert-batch.ts';
import type { ConvertItem } from './convert-batch.ts';

const limits: GifLimits = {
  maxSeconds: 30,
  maxFps: 15,
  maxWidth: 800,
  defaultFps: 10,
  defaultWidth: 480,
};
const ids = {
  a: '00000000-0000-4000-8000-00000000000a',
  b: '00000000-0000-4000-8000-00000000000b',
  c: '00000000-0000-4000-8000-00000000000c',
};

const job = (patch: Partial<Job> = {}): Job => ({
  id: ids.a,
  type: 'upload',
  status: 'done',
  title: 'reunion.mkv',
  sourceUrl: null,
  createdAt: '2026-10-30T12:00:00.000Z',
  startedAt: null,
  finishedAt: '2026-10-30T12:00:01.000Z',
  error: null,
  sizeBytes: 1_400_000_000,
  durationSeconds: 3138,
  format: 'mkv',
  resolution: '1920x1080',
  videoCodec: 'hevc',
  audioCodec: 'aac',
  parentJobId: null,
  followUpJobId: null,
  progress: null,
  ...patch,
});

const video: SourceMedia = {
  hasVideo: true,
  hasAudio: true,
  durationSeconds: 3138,
  width: 1920,
  height: 1080,
  videoCodec: 'hevc',
  audioCodec: 'aac',
};
const audioOnly: SourceMedia = {
  ...video,
  hasVideo: false,
  width: null,
  height: null,
  videoCodec: null,
};

const source = (media: SourceMedia, presets: ConversionSourceResponse['presets'], id = ids.a) => ({
  job: job({ id }),
  media,
  presets,
});

const ALL = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'gif', 'mp3', 'm4a', 'wav'] as const;
const AUDIO = ['mp3', 'm4a', 'wav'] as const;

const readyItem = (id: string, media: SourceMedia, presets: ConversionSourceResponse['presets']) =>
  withSource(newHistoryItem(id, ids.a), source(media, presets), limits);

describe('lista de Convertir', () => {
  it('al analizarse queda lista: MP4 si hay video, MP3 si es solo audio', () => {
    const uploaded = withSource(
      newUploadItem('x', { name: 'reunion.mkv', size: 10 }),
      source(video, [...ALL]),
      limits,
    );
    expect(uploaded).toMatchObject({ status: 'ready', preset: 'mp4', maxHeight: null });
    expect(uploaded.gif).toMatchObject({ startSeconds: 0, endSeconds: 30, fps: 10, width: 480 });
    expect(readyItem('y', audioOnly, [...AUDIO]).preset).toBe('mp3');
  });

  it('conserva el formato elegido al volver a analizar (recarga), si sigue siendo válido', () => {
    const chosen: ConvertItem = {
      ...readyItem('x', video, [...ALL]),
      preset: 'webm',
      maxHeight: 720,
    };
    expect(withSource(chosen, source(video, [...ALL]), limits)).toMatchObject({
      preset: 'webm',
      maxHeight: 720,
    });
    expect(withSource(chosen, source(audioOnly, [...AUDIO]), limits)).toMatchObject({
      preset: 'mp3',
      maxHeight: null,
    });
  });

  it('etiqueta del formato', () => {
    expect(formatTag('mp4', 720)).toBe('MP4 · 720p');
    expect(formatTag('webm', null)).toBe('WebM');
    expect(formatTag('mp3', 720)).toBe('MP3');
    expect(formatTag(null, null)).toBe('—');
  });

  it('un GIF fuera de los topes no se puede convertir', () => {
    const item = { ...readyItem('x', video, [...ALL]), preset: 'gif' as const };
    expect(isConvertible(item, limits)).toBe(true);
    expect(
      isConvertible(
        { ...item, gif: { startSeconds: 0, endSeconds: 45, fps: 10, width: 480 } },
        limits,
      ),
    ).toBe(false);
  });

  it('«Usar este formato en todos» respeta lo que tiene sentido para cada archivo', () => {
    const small = { ...video, width: 1280, height: 720 };
    const items = [
      { ...readyItem('a', video, [...ALL]), preset: 'webm' as const, maxHeight: 480 },
      readyItem('b', small, [...ALL]),
      readyItem('c', audioOnly, [...AUDIO]),
      { ...readyItem('d', video, [...ALL]), status: 'job' as const },
    ];
    const result = applyFormatToAll(items, 'a');
    expect(result[1]).toMatchObject({ preset: 'webm', maxHeight: 480 });
    // Solo audio: no recibe un formato de video.
    expect(result[2]).toBe(items[2]);
    // Ya convirtiéndose: no se toca.
    expect(result[3]).toBe(items[3]);
  });

  it('la resolución solo se copia si es menor que la del archivo', () => {
    const small = { ...video, width: 854, height: 480 };
    const items = [
      { ...readyItem('a', video, [...ALL]), maxHeight: 720 },
      readyItem('b', small, [...ALL]),
    ];
    expect(applyFormatToAll(items, 'a')[1]).toMatchObject({ preset: 'mp4', maxHeight: null });
  });

  it('segunda línea: duración, tamaño y estado', () => {
    expect(itemMeta(readyItem('x', video, [...ALL]))).toBe('52:18 · 1,3 GB · listo');
    expect(itemMeta(newUploadItem('y', { name: 'a.mov', size: 2048 }))).toBe('2 KB · subiendo');
  });

  it('sigue el trabajo de conversión por SSE', () => {
    const item: ConvertItem = { ...readyItem('x', video, [...ALL]), status: 'job', jobId: ids.b };
    const items = [item, readyItem('y', video, [...ALL])];
    const running = job({ id: ids.b, type: 'conversion', status: 'running', finishedAt: null });
    const updated = applyEventToItems(items, { type: 'job.updated', job: running });
    expect(updated[0]?.job?.status).toBe('running');
    expect(updated[1]).toBe(items[1]);
    // Un evento de otro job no cambia nada.
    expect(applyEventToItems(updated, { type: 'job.updated', job: job({ id: ids.c }) })).toBe(
      updated,
    );
  });

  it('?origen= acepta varios ids y descarta lo inválido', () => {
    expect(parseOrigin(`${ids.a},${ids.b},${ids.a},nada`)).toEqual([ids.a, ids.b]);
    expect(parseOrigin(null)).toEqual([]);
  });

  it('se guarda sin lo que se estaba subiendo y al recargar se vuelve a analizar', () => {
    const items = [
      { ...readyItem('a', video, [...ALL]), preset: 'mov' as const },
      newUploadItem('b', { name: 'subiendo.mov', size: 1 }),
      { ...readyItem('c', video, [...ALL]), status: 'job' as const, jobId: ids.b },
    ];
    const restored = restoreBatch(serializeBatch(items));
    expect(restored.map((item) => item.id)).toEqual(['a', 'c']);
    expect(restored[0]).toMatchObject({ status: 'analyzing', preset: 'mov', sourceJobId: ids.a });
    expect(restored[1]).toMatchObject({ status: 'job', jobId: ids.b, job: null });
    expect(restoreBatch('{roto')).toEqual([]);
    expect(restoreBatch(JSON.stringify([{ id: 1 }]))).toEqual([]);
  });
});
