import type { GifLimits, Job, ProbeResponse } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import {
  activeJob,
  applyEventToItems,
  applyPresetToChecked,
  downloadRequest,
  formatLabel,
  isStartable,
  LIVE_MESSAGE,
  newLinkItem,
  parseLinks,
  restoreLinks,
  resultJob,
  rowState,
  serializeLinks,
  startTargets,
  trackedJobIds,
  withProbe,
} from './download-batch.ts';
import type { DownloadItem } from './download-batch.ts';

const limits: GifLimits = {
  maxSeconds: 30,
  maxFps: 15,
  maxWidth: 800,
  defaultFps: 10,
  defaultWidth: 480,
};

/** Igual a lo que devuelve el server para Big Buck Bunny (ver lib/download.test.ts). */
const video: ProbeResponse = {
  url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  title: 'Big Buck Bunny',
  site: 'Youtube',
  uploader: 'Blender',
  thumbnailUrl: null,
  durationSeconds: 635,
  isLive: false,
  hasVideo: true,
  hasAudio: true,
  resolutions: [
    { height: 2160, codecs: ['vp9', 'av1'] },
    { height: 1080, codecs: ['h264', 'vp9', 'av1'] },
    { height: 720, codecs: ['h264', 'vp9', 'av1'] },
  ],
  maxH264Height: 1080,
};
const audioOnly: ProbeResponse = {
  ...video,
  hasVideo: false,
  resolutions: [],
  maxH264Height: null,
};

const ids = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
};

const job = (patch: Partial<Job> = {}): Job => ({
  id: ids.a,
  type: 'download',
  status: 'queued',
  title: 'Big Buck Bunny',
  sourceUrl: video.url,
  createdAt: '2026-11-04T12:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  error: null,
  sizeBytes: null,
  durationSeconds: null,
  format: null,
  resolution: null,
  videoCodec: null,
  audioCodec: null,
  parentJobId: null,
  followUpJobId: null,
  progress: null,
  ...patch,
});

const ready = (probe: ProbeResponse = video, patch: Partial<DownloadItem> = {}): DownloadItem => ({
  ...withProbe(newLinkItem('x', probe.url), probe, limits),
  ...patch,
});

describe('parseLinks', () => {
  it('uno o varios por renglón; avisa los renglones que no son links', () => {
    const text = [
      'https://youtu.be/a',
      'https://youtu.be/b   https://youtu.be/c',
      'youtube video clase',
      '',
      'www.',
    ].join('\n');
    const parsed = parseLinks(text, []);
    expect(parsed.urls).toEqual(['https://youtu.be/a', 'https://youtu.be/b', 'https://youtu.be/c']);
    expect(parsed.invalid).toEqual([
      { line: 3, text: 'youtube' },
      { line: 3, text: 'video' },
      { line: 3, text: 'clase' },
      { line: 5, text: 'www.' },
    ]);
  });

  it('no repite los que ya están en la lista ni los pegados dos veces', () => {
    const parsed = parseLinks('https://youtu.be/a\r\nhttps://youtu.be/b\nhttps://youtu.be/b', [
      'https://youtu.be/a',
    ]);
    expect(parsed).toEqual({ urls: ['https://youtu.be/b'], invalid: [], duplicates: 2 });
  });
});

describe('withProbe', () => {
  it('video: MP4 a la mejor resolución en H.264 (hasta 1080p), modo compatible, GIF por defecto', () => {
    const item = ready();
    expect(item).toMatchObject({
      status: 'ready',
      preset: 'mp4',
      maxHeight: 1080,
      videoMode: 'compat',
      gif: { startSeconds: 0, endSeconds: 30, fps: 10, width: 480 },
    });
  });

  it('solo audio: MP3', () => {
    expect(ready(audioOnly)).toMatchObject({ preset: 'mp3', gif: null });
  });

  it('respeta el formato elegido antes de terminar el análisis, si sirve', () => {
    const pending = { ...newLinkItem('x', video.url), preset: 'gif' as const };
    expect(withProbe(pending, video, limits).preset).toBe('gif');
    expect(withProbe(pending, audioOnly, limits).preset).toBe('mp3');
  });

  it('una transmisión en vivo no se puede descargar', () => {
    const item = ready({ ...video, isLive: true });
    expect(item).toMatchObject({ status: 'failed', error: LIVE_MESSAGE });
    expect(rowState(item)).toBe('live');
  });
});

describe('downloadRequest', () => {
  it('MP4: directo, con resolución y modo', () => {
    expect(downloadRequest(ready())).toEqual({
      url: video.url,
      title: 'Big Buck Bunny',
      format: 'mp4',
      maxHeight: 1080,
      videoMode: 'compat',
    });
  });

  it('MP3 y M4A: directo, sin resolución', () => {
    expect(downloadRequest(ready(video, { preset: 'm4a' }))).toMatchObject({
      format: 'm4a',
      maxHeight: null,
    });
  });

  it('WebM: se baja a la resolución elegida y se convierte', () => {
    expect(downloadRequest(ready(video, { preset: 'webm', maxHeight: 720 }))).toEqual({
      url: video.url,
      title: 'Big Buck Bunny',
      maxHeight: 720,
      then: { preset: 'webm', maxHeight: null },
    });
  });

  it('WAV: sin resolución; GIF: con sus opciones y un origen de hasta 720p', () => {
    expect(downloadRequest(ready(video, { preset: 'wav' }))).toMatchObject({
      maxHeight: null,
      then: { preset: 'wav' },
    });
    const gif = { startSeconds: 2, endSeconds: 6, fps: 12, width: 320 };
    expect(downloadRequest(ready(video, { preset: 'gif', gif }))).toMatchObject({
      maxHeight: 720,
      then: { preset: 'gif', maxHeight: null, gif },
    });
  });
});

describe('isStartable / startTargets', () => {
  it('un GIF con problemas no se puede empezar', () => {
    const bad = ready(video, {
      preset: 'gif',
      gif: { startSeconds: 0, endSeconds: 40, fps: 10, width: 480 },
    });
    expect(isStartable(bad, limits)).toBe(false);
    expect(isStartable(ready(), limits)).toBe(true);
  });

  it('los tildados listos; si no hay tildados, todos los listos', () => {
    const a = ready(video, { id: 'a' });
    const b = ready(video, { id: 'b', checked: true });
    const busy = ready(video, { id: 'c', checked: true, status: 'job' });
    expect(startTargets([a, b, busy], limits).map((item) => item.id)).toEqual(['b']);
    expect(startTargets([a, { ...b, checked: false }], limits).map((item) => item.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('applyPresetToChecked', () => {
  it('cambia el formato de los tildados donde sirve', () => {
    const items = [
      ready(video, { id: 'a', checked: true }),
      ready(audioOnly, { id: 'b', checked: true }),
      ready(video, { id: 'c' }),
    ];
    expect(applyPresetToChecked(items, 'gif').map((item) => item.preset)).toEqual([
      'gif',
      'mp3',
      'mp4',
    ]);
  });
});

describe('rowState y la conversión encadenada', () => {
  const started = (patch: Partial<DownloadItem>) =>
    ready(video, { status: 'job', jobId: ids.a, ...patch });

  it('sigue a la descarga y después a la conversión', () => {
    expect(rowState(started({ job: null }))).toBe('queued');
    expect(rowState(started({ job: job({ status: 'running' }) }))).toBe('running');
    const downloaded = job({ status: 'done', followUpJobId: ids.b });
    expect(rowState(started({ job: downloaded }))).toBe('converting');
    const converting = job({ id: ids.b, type: 'conversion', status: 'running' });
    expect(rowState(started({ job: downloaded, followUp: converting }))).toBe('converting');
    const converted = job({ id: ids.b, type: 'conversion', status: 'done' });
    const item = started({ job: downloaded, followUp: converted });
    expect(rowState(item)).toBe('done');
    expect(resultJob(item)?.id).toBe(ids.b);
  });

  it('una conversión fallida hace fallar la fila', () => {
    const failed = job({ id: ids.b, type: 'conversion', status: 'failed', error: 'GIF inválido.' });
    const item = started({ job: job({ status: 'done', followUpJobId: ids.b }), followUp: failed });
    expect(rowState(item)).toBe('failed');
  });

  it('sin conversión, el resultado es la descarga', () => {
    const item = started({ job: job({ status: 'done' }) });
    expect(rowState(item)).toBe('done');
    expect(resultJob(item)?.id).toBe(ids.a);
  });

  it('cancelar apunta al job que está en curso', () => {
    expect(activeJob(started({ job: job({ status: 'running' }) }))?.id).toBe(ids.a);
    const converting = started({
      job: job({ status: 'done', followUpJobId: ids.b }),
      followUp: job({ id: ids.b, status: 'running' }),
    });
    expect(activeJob(converting)?.id).toBe(ids.b);
  });
});

describe('SSE', () => {
  it('sigue la descarga mientras corre y después su conversión', () => {
    const running = ready(video, { status: 'job', jobId: ids.a, job: job({ status: 'running' }) });
    expect(trackedJobIds([running])).toEqual([ids.a]);
    const downloaded = { ...running, job: job({ status: 'done', followUpJobId: ids.b }) };
    expect(trackedJobIds([downloaded])).toEqual([ids.b]);
    const finished = {
      ...downloaded,
      followUp: job({ id: ids.b, type: 'conversion', status: 'done' }),
    };
    expect(trackedJobIds([finished])).toEqual([]);
  });

  it('aplica eventos de la descarga y de la conversión', () => {
    const items = [ready(video, { status: 'job', jobId: ids.a, job: job({ status: 'running' }) })];
    const done = job({ status: 'done', followUpJobId: ids.b });
    const afterDownload = applyEventToItems(items, { type: 'job.updated', job: done });
    expect(afterDownload[0]?.job).toEqual(done);
    const conversion = job({ id: ids.b, type: 'conversion', status: 'running' });
    const afterConversion = applyEventToItems(afterDownload, {
      type: 'job.updated',
      job: conversion,
    });
    expect(afterConversion[0]?.followUp).toEqual(conversion);
    // Un evento de otro job no cambia nada.
    expect(
      applyEventToItems(afterConversion, {
        type: 'job.updated',
        job: job({ id: '33333333-3333-4333-8333-333333333333' }),
      }),
    ).toBe(afterConversion);
  });
});

describe('sessionStorage', () => {
  it('guarda y recupera la lista; los jobs se retoman por SSE', () => {
    const items = [
      ready(video, { id: 'a', checked: true, preset: 'webm' }),
      ready(video, { id: 'b', status: 'job', jobId: ids.a, job: job() }),
    ];
    const restored = restoreLinks(serializeLinks(items));
    expect(restored[0]).toMatchObject({ id: 'a', checked: true, preset: 'webm', status: 'ready' });
    expect(restored[1]).toMatchObject({ id: 'b', status: 'job', jobId: ids.a, job: null });
  });

  it('ignora lo que no entiende', () => {
    expect(restoreLinks('{roto')).toEqual([]);
    expect(restoreLinks('[{"id":1}]')).toEqual([]);
    expect(restoreLinks(null)).toEqual([]);
  });
});

it('formatLabel', () => {
  expect(formatLabel('mp4')).toBe('Video · MP4');
  expect(formatLabel('gif')).toBe('Animación · GIF');
  expect(formatLabel('wav')).toBe('Solo audio · WAV');
});
