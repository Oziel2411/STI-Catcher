import { describe, expect, it } from 'vitest';
import { healthQuerySchema, healthResponseSchema } from './health.ts';

describe('healthQuerySchema', () => {
  it('interpreta refresh=1 como true y la ausencia como false', () => {
    expect(healthQuerySchema.parse({ refresh: '1' })).toEqual({ refresh: true });
    expect(healthQuerySchema.parse({})).toEqual({ refresh: false });
  });

  it('rechaza valores que no sean 0 o 1', () => {
    expect(healthQuerySchema.safeParse({ refresh: 'yes' }).success).toBe(false);
  });
});

describe('healthResponseSchema', () => {
  it('acepta una herramienta faltante con version null', () => {
    const result = healthResponseSchema.safeParse({
      status: 'degraded',
      app: { version: '0.1.0', nodeVersion: '24.19.0', uptimeSeconds: 3 },
      tools: [{ name: 'deno', version: null, error: 'No encontrado' }],
      disk: { freeBytes: 1, totalBytes: 2, minFreeBytes: 0, isLow: false },
      jobs: { running: 0, queued: 0, maxConcurrent: 2 },
      toolsCheckedAt: '2026-10-29T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});
