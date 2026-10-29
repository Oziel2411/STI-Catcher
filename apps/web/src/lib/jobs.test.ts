import type { Job, JobProgress } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import { applyJobEvent } from './jobs.ts';

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
    expect(applyJobEvent(job, { type: 'job.progress', jobId: job.id, progress })?.progress).toEqual(
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
