import type { AddressInfo } from 'node:net';
import { jobEventSchema } from '@sti-catcher/shared';
import type { JobEvent } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { flush, makeTestApp } from '../../test/test-app.ts';

/**
 * Tests de SSE contra un server real (puerto libre): `inject` no sirve para
 * respuestas que quedan abiertas.
 */
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** Cookie de la sesión de la app que está escuchando (login obligatorio, D-104). */
let session: Record<string, string> = {};
const authFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...session, ...(init.headers as Record<string, string>) } });

async function listen(options: Parameters<typeof makeTestApp>[0] = {}) {
  const testApp = await makeTestApp(options);
  session = testApp.ana.headers;
  apps.push(testApp.app);
  await testApp.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = testApp.app.server.address() as AddressInfo;
  return { ...testApp, base: `http://127.0.0.1:${String(port)}` };
}

/** Lee un stream SSE y junta eventos y latidos hasta que `until` devuelva true. */
async function readSse(
  response: Response,
  until: (state: { events: JobEvent[]; pings: number }) => boolean,
) {
  const state = { events: [] as JobEvent[], pings: 0, ended: false };
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error('Sin body');
  let buffer = '';
  while (!until(state)) {
    const { value, done } = await reader.read();
    if (done) {
      state.ended = true;
      break;
    }
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      // Los latidos (`event: ping`) se cuentan aparte; no son eventos de jobs.
      if (block.startsWith('event: ping')) {
        state.pings++;
        continue;
      }
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      if (data) state.events.push(jobEventSchema.parse(JSON.parse(data.slice(6))));
    }
  }
  await reader.cancel().catch(() => undefined);
  return state;
}

describe('GET /api/jobs/:id/events', () => {
  it('manda el estado actual, el progreso en vivo y cierra al terminar el job', async () => {
    const { base, runs } = await listen();
    const created = (await (
      await authFetch(`${base}/api/jobs/selftest`, { method: 'POST' })
    ).json()) as {
      jobId: string;
    };
    await flush();

    const response = await authFetch(`${base}/api/jobs/${created.jobId}/events`);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

    const reading = readSse(response, () => false); // hasta que el server cierre
    await flush();
    runs[0]?.context.reportProgress({
      phase: 'processing',
      percent: 50,
      speedBytesPerSecond: null,
      speedRatio: 1,
      etaSeconds: 5,
    });
    runs[0]?.resolve({ output: null });

    const { events, ended } = await reading;
    expect(ended).toBe(true);
    expect(events.map((e) => (e.type === 'job.updated' ? e.job.status : 'progress'))).toEqual([
      'running',
      'progress',
      'done',
    ]);
  });

  it('si el job ya terminó, manda su estado y cierra', async () => {
    const { base, queue } = await listen();
    const created = (await (
      await authFetch(`${base}/api/jobs/selftest`, { method: 'POST' })
    ).json()) as {
      jobId: string;
    };
    queue.cancel(created.jobId);
    await flush();
    const { events, ended } = await readSse(
      await authFetch(`${base}/api/jobs/${created.jobId}/events`),
      () => false,
    );
    expect(ended).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('404 en JSON para un job que no existe', async () => {
    const { base } = await listen();
    const response = await authFetch(
      `${base}/api/jobs/00000000-0000-4000-8000-999999999999/events`,
    );
    expect(response.status).toBe(404);
  });
});

describe('GET /api/events', () => {
  it('sin filtro recibe todos los jobs; con jobIds, solo esos', async () => {
    const { base, queue } = await listen();
    const all = readSse(await authFetch(`${base}/api/events`), (s) => s.events.length >= 2);

    const a = await queue.enqueue({ type: 'selftest', params: { durationSeconds: 5 } });
    const filtered = readSse(await authFetch(`${base}/api/events?jobIds=${a.id}`), (s) =>
      s.events.some((e) => e.type === 'job.updated' && e.job.status === 'cancelled'),
    );
    await flush();
    await queue.enqueue({ type: 'selftest', params: { durationSeconds: 5 } });
    queue.cancel(a.id);

    const allState = await all;
    expect(allState.events.length).toBeGreaterThanOrEqual(2);
    const filteredState = await filtered;
    expect(
      filteredState.events.every((e) => (e.type === 'job.updated' ? e.job.id : e.jobId) === a.id),
    ).toBe(true);
  });

  it('manda heartbeats para mantener viva la conexión', async () => {
    const { base } = await listen({ sseHeartbeatMs: 20 });
    const state = await readSse(await authFetch(`${base}/api/events`), (s) => s.pings >= 2);
    expect(state.pings).toBeGreaterThanOrEqual(2);
  });

  it('app.close() cierra los streams abiertos en vez de quedarse esperando', async () => {
    const { app, base } = await listen();
    const reading = readSse(await authFetch(`${base}/api/events`), () => false);
    await flush();
    apps.splice(apps.indexOf(app), 1);
    await app.close();
    expect((await reading).ended).toBe(true);
  }, 5_000);
});

describe('SSE sin sesión', () => {
  it('401 sin cookie de sesión (login obligatorio, D-104)', async () => {
    const { base } = await listen();
    const response = await fetch(`${base}/api/events`);
    expect(response.status).toBe(401);
  });
});
