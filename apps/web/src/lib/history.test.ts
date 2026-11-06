import type { HistoryItem, Job } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import {
  fileDetails,
  historyActions,
  isAudioOnly,
  isImage,
  isNewJobEvent,
  siteName,
} from './history.ts';

const job: Job = {
  id: '00000000-0000-4000-8000-00000000000a',
  type: 'download',
  status: 'done',
  title: 'Me at the zoo',
  sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  createdAt: '2026-11-06T12:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  error: null,
  sizeBytes: 744_000,
  durationSeconds: 19,
  format: 'mp4',
  resolution: '320x240',
  videoCodec: 'h264',
  audioCodec: 'aac',
  parentJobId: null,
  followUpJobId: null,
  progress: null,
};
const item: HistoryItem = { ...job, isMine: true, parentTitle: null, requester: 'SISTEMAS2-PC' };

describe('fileDetails', () => {
  it('formato, resolución y duración', () => {
    expect(fileDetails(item)).toBe('MP4 · 320x240 · 0:19');
  });

  it('sin datos del archivo', () => {
    expect(fileDetails({ ...item, format: null, resolution: null, durationSeconds: null })).toBe(
      '—',
    );
  });
});

it('isAudioOnly', () => {
  expect(isAudioOnly(item)).toBe(false);
  expect(isAudioOnly({ ...item, format: 'mp3', resolution: null, videoCodec: null })).toBe(true);
  expect(isAudioOnly({ ...item, format: 'webm', resolution: null, videoCodec: null })).toBe(true);
});

it('siteName', () => {
  expect(siteName(item.sourceUrl)).toBe('youtube.com');
  expect(siteName('no es un link')).toBeNull();
  expect(siteName(null)).toBeNull();
});

describe('historyActions', () => {
  it('terminado y propio: todo menos cancelar y reintentar', () => {
    expect(historyActions(item)).toEqual({
      play: true,
      download: true,
      convert: true,
      openOriginal: true,
      retry: false,
      cancel: false,
      remove: true,
    });
  });

  it('en curso: solo quien lo pidió lo cancela, y no se borra', () => {
    const running = { ...item, status: 'running' as const };
    expect(historyActions(running)).toMatchObject({ cancel: true, remove: false, play: false });
    expect(historyActions({ ...running, isMine: false })).toMatchObject({
      cancel: false,
      remove: false,
    });
  });

  it('se reintentan descargas y conversiones fallidas, no grabaciones', () => {
    expect(historyActions({ ...item, status: 'failed' }).retry).toBe(true);
    expect(historyActions({ ...item, status: 'cancelled', type: 'conversion' }).retry).toBe(true);
    expect(historyActions({ ...item, status: 'failed', type: 'recording' }).retry).toBe(false);
  });
});

describe('isNewJobEvent', () => {
  const newer = {
    ...job,
    id: '00000000-0000-4000-8000-00000000000b',
    createdAt: '2026-11-06T12:05:00.000Z',
  };

  it('un trabajo nuevo, más reciente que la lista', () => {
    expect(isNewJobEvent({ type: 'job.updated', job: newer }, [item])).toBe(true);
    expect(isNewJobEvent({ type: 'job.updated', job: newer }, [])).toBe(true);
  });

  it('no: ya está en la lista, es más viejo, es progreso o es la prueba del sistema', () => {
    expect(isNewJobEvent({ type: 'job.updated', job }, [item])).toBe(false);
    expect(
      isNewJobEvent(
        { type: 'job.updated', job: { ...newer, createdAt: '2026-11-06T11:00:00.000Z' } },
        [item],
      ),
    ).toBe(false);
    expect(
      isNewJobEvent(
        {
          type: 'job.progress',
          jobId: newer.id,
          progress: {
            phase: 'downloading',
            percent: 1,
            speedBytesPerSecond: null,
            speedRatio: null,
            etaSeconds: null,
          },
        },
        [item],
      ),
    ).toBe(false);
    expect(
      isNewJobEvent({ type: 'job.updated', job: { ...newer, type: 'selftest' } }, [item]),
    ).toBe(false);
  });
});

it('isImage: el GIF se muestra como imagen', () => {
  expect(isImage({ ...item, format: 'gif' })).toBe(true);
  expect(isImage(item)).toBe(false);
});
