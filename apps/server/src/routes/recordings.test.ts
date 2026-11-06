import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  apiErrorSchema,
  chunkResponseSchema,
  createRecordingResponseSchema,
  finishRecordingResponseSchema,
} from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { flush, makeTestApp } from '../../test/test-app.ts';
// Los pedidos van con la sesión por defecto de la app de prueba («ana»).

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app(options: Parameters<typeof makeTestApp>[0] = {}) {
  const testApp = await makeTestApp(options);
  storageDirs.push(testApp.storageDir);
  return testApp;
}
type TestApp = Awaited<ReturnType<typeof app>>;

async function start(testApp: TestApp, mimeType = 'video/webm;codecs=vp9,opus') {
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/recordings',
    payload: { mimeType, fps: 30, title: 'Grabación de prueba' },
  });
  expect(response.statusCode).toBe(201);
  return createRecordingResponseSchema.parse(response.json()).recordingId;
}

const sendChunk = (
  testApp: TestApp,
  id: string,
  seq: number,
  body: Buffer,
  headers: Record<string, string> = {},
) =>
  testApp.app.inject({
    method: 'POST',
    url: `/api/recordings/${id}/chunks?seq=${String(seq)}`,
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: body,
  });

const finish = (testApp: TestApp, id: string, headers: Record<string, string> = {}) =>
  testApp.app.inject({ method: 'POST', url: `/api/recordings/${id}/finish`, headers });

const rawFile = (testApp: TestApp, id: string, ext = 'webm') =>
  path.join(testApp.recordingsDir, `${id}.${ext}`);

describe('POST /api/recordings', () => {
  it('acepta los formatos de MediaRecorder y rechaza otros', async () => {
    const testApp = await app();
    await start(testApp, 'video/mp4;codecs=avc1,mp4a.40.2');
    const bad = await testApp.app.inject({
      method: 'POST',
      url: '/api/recordings',
      payload: { mimeType: 'video/x-msvideo', fps: 30, title: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    const badFps = await testApp.app.inject({
      method: 'POST',
      url: '/api/recordings',
      payload: { mimeType: 'video/webm', fps: 24, title: 'x' },
    });
    expect(badFps.statusCode).toBe(400);
  });
});

describe('fragmentos', () => {
  it('se agregan en orden al archivo crudo', async () => {
    const testApp = await app();
    const id = await start(testApp);
    for (const [seq, byte] of [
      [0, 1],
      [1, 2],
      [2, 3],
    ] as const) {
      const response = await sendChunk(testApp, id, seq, Buffer.alloc(100, byte));
      expect(chunkResponseSchema.parse(response.json())).toEqual({ nextSeq: seq + 1 });
    }
    expect(readFileSync(rawFile(testApp, id))).toEqual(
      Buffer.concat([Buffer.alloc(100, 1), Buffer.alloc(100, 2), Buffer.alloc(100, 3)]),
    );
  });

  it('un fragmento repetido (reintento) se ignora sin error y no se duplica', async () => {
    const testApp = await app();
    const id = await start(testApp);
    await sendChunk(testApp, id, 0, Buffer.alloc(100, 1));
    const retry = await sendChunk(testApp, id, 0, Buffer.alloc(100, 9));
    expect(retry.statusCode).toBe(200);
    expect(chunkResponseSchema.parse(retry.json())).toEqual({ nextSeq: 1 });
    expect(readFileSync(rawFile(testApp, id))).toEqual(Buffer.alloc(100, 1));
  });

  it('409 si falta un fragmento anterior', async () => {
    const testApp = await app();
    const id = await start(testApp);
    const response = await sendChunk(testApp, id, 1, Buffer.alloc(10));
    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('OUT_OF_ORDER');
    expect(existsSync(rawFile(testApp, id))).toBe(false);
  });

  it('solo la cuenta que la creó puede agregar fragmentos', async () => {
    const testApp = await app();
    const id = await start(testApp);
    const response = await sendChunk(
      testApp,
      id,
      0,
      Buffer.alloc(10),
      (await testApp.loginAs('beto@capitanes.ar')).headers,
    );
    expect(response.statusCode).toBe(403);
  });

  it('se procesan muchos fragmentos seguidos sin mezclarse (cada uno espera al anterior)', async () => {
    const testApp = await app();
    const id = await start(testApp);
    // Llegan todos a la vez; el server los serializa.
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, seq) => sendChunk(testApp, id, seq, Buffer.alloc(10, seq))),
    );
    const ok = responses.filter((r) => r.statusCode === 200).length;
    // El orden de llegada no está garantizado: los que llegan antes de tiempo reciben 409 y el
    // navegador los reenvía. Lo importante: lo escrito está completo y en orden, sin mezclas.
    expect(ok).toBeGreaterThan(0);
    const written = readFileSync(rawFile(testApp, id));
    expect(written.length).toBe(ok * 10);
    for (let seq = 0; seq < ok; seq++) {
      expect(written.subarray(seq * 10, seq * 10 + 10)).toEqual(Buffer.alloc(10, seq));
    }
  });
});

describe('POST /api/recordings/:id/finish', () => {
  it('crea el job de procesamiento con el título; repetir devuelve el mismo job', async () => {
    const testApp = await app();
    const id = await start(testApp);
    await sendChunk(testApp, id, 0, Buffer.alloc(100));
    testApp.clock.now = new Date('2026-10-29T12:02:00.000Z');
    await sendChunk(testApp, id, 1, Buffer.alloc(100));

    const response = await finish(testApp, id);
    expect(response.statusCode).toBe(202);
    const { jobId } = finishRecordingResponseSchema.parse(response.json());
    await flush();
    expect(testApp.repo.get(jobId)).toMatchObject({
      type: 'recording',
      title: 'Grabación de prueba',
      userId: testApp.ana.user.id,
      params: { recordingId: id, extension: 'webm', fps: 30, estimatedSeconds: 120 },
    });

    const again = finishRecordingResponseSchema.parse((await finish(testApp, id)).json());
    expect(again.jobId).toBe(jobId);
    // Ya cerrada: no acepta más fragmentos.
    expect((await sendChunk(testApp, id, 2, Buffer.alloc(10))).statusCode).toBe(409);
  });

  it('409 si no se grabó nada', async () => {
    const testApp = await app();
    const id = await start(testApp);
    const response = await finish(testApp, id);
    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('EMPTY');
  });
});

describe('grabaciones abandonadas (pestaña cerrada, D-032)', () => {
  it('sin fragmentos durante 2 minutos se procesa lo que llegó', async () => {
    const testApp = await app();
    const id = await start(testApp);
    await sendChunk(testApp, id, 0, Buffer.alloc(100));

    testApp.clock.now = new Date('2026-10-29T12:01:00.000Z');
    await testApp.recordings.sweepIdle();
    expect(testApp.recordingsRepo.get(id)?.status).toBe('recording');

    testApp.clock.now = new Date('2026-10-29T12:02:01.000Z');
    await testApp.recordings.sweepIdle();
    const session = testApp.recordingsRepo.get(id);
    expect(session?.status).toBe('finalized');
    expect(testApp.repo.get(session?.jobId ?? '')?.type).toBe('recording');
  });

  it('una grabación abandonada sin datos se descarta', async () => {
    const testApp = await app();
    const id = await start(testApp);
    testApp.clock.now = new Date('2026-10-29T12:05:00.000Z');
    await testApp.recordings.sweepIdle();
    expect(testApp.recordingsRepo.get(id)?.status).toBe('discarded');
  });
});
