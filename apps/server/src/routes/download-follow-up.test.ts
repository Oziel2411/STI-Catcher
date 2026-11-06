import { rmSync } from 'node:fs';
import { apiErrorSchema, createJobResponseSchema, jobResponseSchema } from '@sti-catcher/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, makeTestApp } from '../../test/test-app.ts';

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

async function startDownload(testApp: TestApp, payload: Record<string, unknown>) {
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/jobs/download',
    payload: { url: 'https://youtu.be/aqz-KE-bpKQ', title: 'Big Buck Bunny', ...payload },
  });
  expect(response.statusCode).toBe(202);
  const { jobId } = createJobResponseSchema.parse(response.json());
  await flush();
  return jobId;
}

/** Termina bien el job que está corriendo, como si el runner hubiera dejado un archivo. */
function finishRun(testApp: TestApp, index: number, extension: string) {
  const run = testApp.runs[index];
  if (!run) throw new Error(`No hay un job corriendo en la posición ${String(index)}`);
  run.resolve({
    output: { tempPath: `${run.context.job.id}${extension}`, extension },
    metadata: { title: 'Big Buck Bunny' },
  });
}

async function getJob(testApp: TestApp, id: string) {
  const response = await testApp.app.inject({ method: 'GET', url: `/api/jobs/${id}` });
  return jobResponseSchema.parse(response.json()).job;
}

describe('POST /api/jobs/download con `then` (conversión encadenada)', () => {
  it('baja MP4 compatible para un preset de video y guarda la conversión pedida', async () => {
    const testApp = await app();
    await startDownload(testApp, {
      format: 'mp3',
      videoMode: 'quality',
      maxHeight: 720,
      then: { preset: 'webm', maxHeight: 480 },
    });
    expect(testApp.runs[0]?.context.job.params).toMatchObject({
      format: 'mp4',
      videoMode: 'compat',
      maxHeight: 720,
      then: { preset: 'webm', maxHeight: 480 },
    });
  });

  it('baja M4A para un preset de audio', async () => {
    const testApp = await app();
    await startDownload(testApp, { maxHeight: 720, then: { preset: 'wav' } });
    expect(testApp.runs[0]?.context.job.params).toMatchObject({
      format: 'm4a',
      maxHeight: null,
      then: { preset: 'wav', maxHeight: null },
    });
  });

  it('400 si pide GIF sin sus opciones; no crea el job', async () => {
    const testApp = await app();
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'https://youtu.be/x', then: { preset: 'gif' } },
    });
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.issues).toContainEqual({
      path: 'then.gif',
      message: 'Para el GIF hay que indicar inicio, fin, FPS y ancho.',
    });
    expect(testApp.queue.list({ limit: 10 })).toHaveLength(0);
  });

  it('al terminar crea la conversión, la vincula y la publica en el mismo evento', async () => {
    const testApp = await app();
    const events: unknown[] = [];
    testApp.bus.subscribe((event) => events.push(event));
    const downloadId = await startDownload(testApp, { then: { preset: 'webm', maxHeight: 480 } });

    finishRun(testApp, 0, '.mp4');
    await vi.waitFor(async () => {
      expect((await getJob(testApp, downloadId)).followUpJobId).not.toBeNull();
    });

    const download = await getJob(testApp, downloadId);
    expect(download.status).toBe('done');
    const followUpId = download.followUpJobId ?? '';
    expect(await getJob(testApp, followUpId)).toMatchObject({
      type: 'conversion',
      parentJobId: downloadId,
      title: 'Big Buck Bunny → WEBM',
    });
    // La conversión corre como cualquier otra: con los parámetros pedidos.
    await vi.waitFor(() => {
      expect(testApp.runs[1]?.context.job.params).toEqual({
        sourceJobId: downloadId,
        preset: 'webm',
        maxHeight: 480,
      });
    });
    // El evento "done" de la descarga ya trae el vínculo: la UI no tiene que volver a pedirla.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'job.updated',
        job: expect.objectContaining({
          id: downloadId,
          status: 'done',
          followUpJobId: followUpId,
        }) as unknown,
      }),
    );
  });

  it('la conversión queda a nombre de la misma cuenta que la descarga', async () => {
    const testApp = await app();
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'https://youtu.be/x', then: { preset: 'mp3' } },
    });
    const { jobId } = createJobResponseSchema.parse(response.json());
    await flush();
    finishRun(testApp, 0, '.m4a');
    await vi.waitFor(() => {
      expect(testApp.repo.get(jobId)?.followUpJobId).not.toBeNull();
    });
    const followUp = testApp.repo.get(testApp.repo.get(jobId)?.followUpJobId ?? '');
    expect(testApp.repo.get(jobId)?.userId).toBe(testApp.ana.user.id);
    expect(followUp?.userId).toBe(testApp.ana.user.id);
  });

  it('si las opciones no sirven para lo bajado, deja una conversión fallida con el motivo', async () => {
    // El video de prueba dura 12 s: un GIF de 20 a 25 s no se puede hacer.
    const testApp = await app();
    const downloadId = await startDownload(testApp, {
      then: { preset: 'gif', gif: { startSeconds: 20, endSeconds: 25, fps: 10, width: 480 } },
    });
    finishRun(testApp, 0, '.mp4');
    await vi.waitFor(async () => {
      expect((await getJob(testApp, downloadId)).followUpJobId).not.toBeNull();
    });
    const download = await getJob(testApp, downloadId);
    expect(download.status).toBe('done');
    const followUp = await getJob(testApp, download.followUpJobId ?? '');
    expect(followUp).toMatchObject({
      type: 'conversion',
      status: 'failed',
      parentJobId: downloadId,
      title: 'Big Buck Bunny → GIF',
    });
    expect(followUp.error).toContain('posterior al final del video');
    // Nada quedó en la cola.
    await flush();
    expect(testApp.runs).toHaveLength(1);
  });

  it('si la descarga se cancela, no se crea la conversión', async () => {
    const testApp = await app();
    const downloadId = await startDownload(testApp, { then: { preset: 'mp3' } });
    await testApp.app.inject({ method: 'POST', url: `/api/jobs/${downloadId}/cancel` });
    await vi.waitFor(async () => {
      expect((await getJob(testApp, downloadId)).status).toBe('cancelled');
    });
    await flush();
    expect((await getJob(testApp, downloadId)).followUpJobId).toBeNull();
    expect(testApp.queue.list({ limit: 10, types: ['conversion'] })).toEqual([]);
  });

  it('reintentar una descarga fallida vuelve a encadenar la conversión', async () => {
    const testApp = await app();
    const downloadId = await startDownload(testApp, { then: { preset: 'mov', maxHeight: null } });
    testApp.repo.finish(downloadId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: 'Se cortó la conexión.',
    });
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/jobs/${downloadId}/retry`,
    });
    expect(response.statusCode).toBe(202);
    const { jobId } = createJobResponseSchema.parse(response.json());
    expect(testApp.repo.get(jobId)?.params).toMatchObject({ then: { preset: 'mov' } });
  });
});
