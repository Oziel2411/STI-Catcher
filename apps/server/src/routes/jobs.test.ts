import {
  apiErrorSchema,
  createJobResponseSchema,
  jobResponseSchema,
  listJobsResponseSchema,
} from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import { flush, makeTestApp } from '../../test/test-app.ts';

const UNKNOWN_ID = '00000000-0000-4000-8000-999999999999';

describe('POST /api/jobs/selftest', () => {
  it('responde 202 con el jobId de inmediato y el job arranca en segundo plano', async () => {
    const { app, runs } = await makeTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs/selftest',
      payload: { durationSeconds: 10 },
    });
    expect(response.statusCode).toBe(202);
    const { jobId } = createJobResponseSchema.parse(response.json());

    await flush();
    expect(runs[0]?.context.job).toMatchObject({
      id: jobId,
      type: 'selftest',
      params: { durationSeconds: 10 },
      title: 'Prueba del sistema (10 s)',
      clientIp: '127.0.0.1',
    });
  });

  it('acepta body vacío (60 s por defecto)', async () => {
    const { app, runs } = await makeTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/jobs/selftest' });
    expect(response.statusCode).toBe(202);
    await flush();
    expect(runs[0]?.context.job.params).toEqual({ durationSeconds: 60 });
  });

  it('valida la duración', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs/selftest',
      payload: { durationSeconds: 99999 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('responde 507 con mensaje claro si no hay espacio en disco', async () => {
    const { app } = await makeTestApp({ freeDiskBytes: 10 });
    const response = await app.inject({ method: 'POST', url: '/api/jobs/selftest' });
    expect(response.statusCode).toBe(507);
    const body = apiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('INSUFFICIENT_DISK');
    expect(body.error.message).toMatch(/Espacio insuficiente/);
  });
});

describe('GET /api/jobs y /api/jobs/:id', () => {
  it('lista con filtros y devuelve un job por id', async () => {
    const { app } = await makeTestApp();
    const a = createJobResponseSchema.parse(
      (await app.inject({ method: 'POST', url: '/api/jobs/selftest' })).json(),
    );
    await app.inject({ method: 'POST', url: '/api/jobs/selftest' });
    await flush();

    const running = listJobsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/jobs?status=running&type=selftest' })).json(),
    );
    expect(running.jobs.map((j) => j.id)).toEqual([a.jobId]);

    const one = jobResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/jobs/${a.jobId}` })).json(),
    );
    expect(one.job.status).toBe('running');
  });

  it('404 para un id que no existe y 400 para uno mal formado', async () => {
    const { app } = await makeTestApp();
    expect((await app.inject({ method: 'GET', url: `/api/jobs/${UNKNOWN_ID}` })).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/api/jobs/..%5C..%5Cwin.ini' })).statusCode,
    ).toBe(400);
  });
});

describe('POST /api/jobs/:id/cancel', () => {
  it('202 para un job en curso, 200 para uno en cola, 409 si ya terminó', async () => {
    const { app, queue } = await makeTestApp(); // concurrencia 1
    const running = createJobResponseSchema.parse(
      (await app.inject({ method: 'POST', url: '/api/jobs/selftest' })).json(),
    );
    const queued = createJobResponseSchema.parse(
      (await app.inject({ method: 'POST', url: '/api/jobs/selftest' })).json(),
    );
    await flush();

    const cancelQueued = await app.inject({
      method: 'POST',
      url: `/api/jobs/${queued.jobId}/cancel`,
    });
    expect(cancelQueued.statusCode).toBe(200);
    expect(jobResponseSchema.parse(cancelQueued.json()).job.status).toBe('cancelled');

    const cancelRunning = await app.inject({
      method: 'POST',
      url: `/api/jobs/${running.jobId}/cancel`,
    });
    expect(cancelRunning.statusCode).toBe(202);
    await flush();
    expect(queue.get(running.jobId)?.status).toBe('cancelled');

    const again = await app.inject({ method: 'POST', url: `/api/jobs/${running.jobId}/cancel` });
    expect(again.statusCode).toBe(409);
    expect(apiErrorSchema.parse(again.json()).error.code).toBe('JOB_NOT_ACTIVE');
  });

  it('404 si no existe', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ method: 'POST', url: `/api/jobs/${UNKNOWN_ID}/cancel` });
    expect(response.statusCode).toBe(404);
  });
});
