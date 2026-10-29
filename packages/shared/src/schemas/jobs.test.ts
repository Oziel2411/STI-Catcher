import { describe, expect, it } from 'vitest';
import {
  createSelftestRequestSchema,
  eventsQuerySchema,
  isActiveStatus,
  jobEventSchema,
  listJobsQuerySchema,
} from './jobs.ts';

const UUID = '7f1c2a8e-3b4d-4e5f-9a6b-1c2d3e4f5a6b';

describe('listJobsQuerySchema', () => {
  it('convierte listas separadas por comas y aplica el límite por defecto', () => {
    expect(listJobsQuerySchema.parse({ status: 'queued, running', type: 'selftest' })).toEqual({
      status: ['queued', 'running'],
      type: ['selftest'],
      limit: 50,
    });
  });

  it('rechaza estados desconocidos y límites fuera de rango', () => {
    expect(listJobsQuerySchema.safeParse({ status: 'queued,borrado' }).success).toBe(false);
    expect(listJobsQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
});

describe('eventsQuerySchema', () => {
  it('acepta ids válidos y rechaza basura', () => {
    expect(eventsQuerySchema.parse({ jobIds: UUID })).toEqual({ jobIds: [UUID] });
    expect(eventsQuerySchema.safeParse({ jobIds: '../../etc' }).success).toBe(false);
  });
});

describe('createSelftestRequestSchema', () => {
  it('usa 60 s por defecto y limita la duración', () => {
    expect(createSelftestRequestSchema.parse({})).toEqual({ durationSeconds: 60 });
    expect(createSelftestRequestSchema.safeParse({ durationSeconds: 3600 }).success).toBe(false);
  });
});

describe('jobEventSchema', () => {
  it('valida un evento de progreso', () => {
    const event = {
      type: 'job.progress',
      jobId: UUID,
      progress: {
        phase: 'processing',
        percent: 42.5,
        speedBytesPerSecond: null,
        speedRatio: 1,
        etaSeconds: 34,
      },
    };
    expect(jobEventSchema.parse(event)).toEqual(event);
  });
});

describe('isActiveStatus', () => {
  it('solo queued y running están activos', () => {
    expect(isActiveStatus('queued')).toBe(true);
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('done')).toBe(false);
    expect(isActiveStatus('expired')).toBe(false);
  });
});
