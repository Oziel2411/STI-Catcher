import type { Job, JobProgress } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import { applyEventToList, applyJobEvent } from './jobs.ts';

describe('applyEventToList', () => {
  const base = {
    type: 'download' as const,
    status: 'done' as const,
    title: 'x',
    sourceUrl: null,
    createdAt: '2026-10-29T12:00:00.000Z',
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
  };
  const a = {
    ...base,
    id: '00000000-0000-4000-8000-00000000000a',
    isMine: true,
    parentTitle: null,
  };
  const b = {
    ...base,
    id: '00000000-0000-4000-8000-00000000000b',
    isMine: false,
    parentTitle: 'Origen',
  };

  it('actualiza el job y conserva isMine (los eventos no lo traen)', () => {
    const next = applyEventToList([a, b], {
      type: 'job.updated',
      job: { ...base, id: a.id, status: 'expired' },
    });
    expect(next[0]).toEqual({ ...a, status: 'expired' });
    expect(next[1]).toBe(b);
  });

  it('quita los borrados', () => {
    expect(applyEventToList([a, b], { type: 'job.deleted', jobId: a.id })).toEqual([b]);
  });

  it('devuelve la misma lista si el evento no es de ningún job visible', () => {
    const items = [a, b];
    expect(
      applyEventToList(items, {
        type: 'job.deleted',
        jobId: '00000000-0000-4000-8000-00000000000c',
      }),
    ).toBe(items);
  });
});

const job: Job = {
  id: '00000000-0000-4000-8000-00000000000a',
  type: 'selftest',
  status: 'running',
  title: 'Prueba',
  sourceUrl: null,
  createdAt: '2026-10-29T12:00:00.000Z',
  startedAt: '2026-10-29T12:00:01.000Z',
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
};

const progress: JobProgress = {
  phase: 'processing',
  percent: 30,
  speedBytesPerSecond: null,
  speedRatio: 1,
  etaSeconds: 7,
};

describe('applyJobEvent', () => {
  it('reemplaza el job con job.updated', () => {
    const updated = { ...job, status: 'done' as const };
    expect(applyJobEvent(job, { type: 'job.updated', job: updated })).toBe(updated);
  });

  it('agrega el progreso si el job está corriendo', () => {
    expect(applyJobEvent(job, { type: 'job.progress', jobId: job.id, progress }).progress).toEqual(
      progress,
    );
  });

  it('ignora progreso tardío de un job que ya terminó', () => {
    const done = { ...job, status: 'done' as const };
    expect(applyJobEvent(done, { type: 'job.progress', jobId: job.id, progress })).toBe(done);
  });

  it('ignora eventos de otros jobs', () => {
    const other = { ...job, id: '00000000-0000-4000-8000-00000000000b' };
    expect(applyJobEvent(job, { type: 'job.updated', job: other })).toBe(job);
  });
});
