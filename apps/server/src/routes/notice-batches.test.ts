import { rmSync } from 'node:fs';
import { createJobResponseSchema, createNoticeBatchResponseSchema } from '@sti-catcher/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, makeTestApp } from '../../test/test-app.ts';
import { JobError } from '../jobs/errors.ts';
import { BATCH_GRACE_MS } from '../modules/notifications/job-notice.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app() {
  const testApp = await makeTestApp();
  storageDirs.push(testApp.storageDir);
  const beto = await testApp.loginAs('beto@capitanes.ar');
  return { ...testApp, beto };
}
type TestApp = Awaited<ReturnType<typeof app>>;

function finishRun(t: TestApp, index: number, extension = '.mp4') {
  const run = t.runs[index];
  if (!run) throw new Error(`No hay un job corriendo en la posición ${String(index)}`);
  run.resolve({
    output: { tempPath: `${run.context.job.id}${extension}`, extension },
    metadata: { durationSeconds: 65, sizeBytes: 2 * 1024 ** 2 },
  });
}

const waitRuns = (t: TestApp, count: number) =>
  vi.waitFor(() => {
    expect(t.runs).toHaveLength(count);
  });

async function openBatch(t: TestApp, notify: string[], headers?: Record<string, string>) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/notice-batches',
    payload: { notify },
    ...(headers ? { headers } : {}),
  });
  expect(response.statusCode).toBe(201);
  return createNoticeBatchResponseSchema.parse(response.json()).batchId;
}

async function download(t: TestApp, payload: Record<string, unknown>) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/jobs/download',
    payload: { url: 'https://youtu.be/x', ...payload },
  });
  return {
    response,
    jobId:
      response.statusCode === 202 ? createJobResponseSchema.parse(response.json()).jobId : null,
  };
}

const close = (t: TestApp, batchId: string) =>
  t.app.inject({ method: 'POST', url: `/api/notice-batches/${batchId}/close` });

describe('aviso agrupado (D-105)', () => {
  it('varios links: un solo mail cuando terminan todos, con listas y fallas', async () => {
    const t = await app();
    const batchId = await openBatch(t, [t.ana.user.id, t.beto.user.id]);
    await download(t, { title: 'Uno', batchId, notify: [t.ana.user.id] });
    await download(t, { title: 'Dos', batchId, notify: [t.ana.user.id] });
    await download(t, { title: 'Tres', batchId, notify: [t.ana.user.id] });
    expect((await close(t, batchId)).statusCode).toBe(204);

    await waitRuns(t, 1);
    finishRun(t, 0);
    await waitRuns(t, 2);
    t.runs[1]?.reject(new JobError('El video no existe o fue eliminado.'));
    await waitRuns(t, 3);
    await flush();
    expect(t.sentMails).toHaveLength(0);
    finishRun(t, 2);

    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    await flush();
    expect(t.sentMails).toHaveLength(1);
    const mail = t.sentMails[0];
    // Van a las cuentas elegidas al abrir el pedido.
    expect(mail?.to).toEqual(['ana@capitanes.ar', 'beto@capitanes.ar']);
    expect(mail?.subject).toBe('Descargas terminadas: 2 de 3 listas');
    expect(mail?.text).toContain('Terminó un pedido de 3 descargas. 2 están en el Historial');
    // El tamaño lo mide la cola sobre el archivo (en el test, uno vacío).
    expect(mail?.text).toMatch(/Listas \(2\):\n- Uno \(.*, 1:05\)\n- Tres \(.*, 1:05\)/);
    expect(mail?.text).toContain(
      'No se pudieron completar (1):\n- Dos: El video no existe o fue eliminado.',
    );
    expect(mail?.text).toContain('Pedido por: ana (desde 127.0.0.1)');
    expect(mail?.text).toContain('Historial: https://sti.test/historial');
  });

  it('espera al cierre: si todo terminó antes, avisa al cerrar', async () => {
    const t = await app();
    const batchId = await openBatch(t, [t.ana.user.id]);
    await download(t, { title: 'Uno', batchId });
    await waitRuns(t, 1);
    finishRun(t, 0);
    await download(t, { title: 'Dos', batchId });
    await waitRuns(t, 2);
    finishRun(t, 1);
    await flush();
    await flush();
    expect(t.sentMails).toHaveLength(0);

    await close(t, batchId);
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    expect(t.sentMails[0]?.subject).toBe('Descargas terminadas: 2 de 2 listas');
    // Cerrar de nuevo no repite el mail.
    expect((await close(t, batchId)).statusCode).toBe(204);
    await flush();
    expect(t.sentMails).toHaveLength(1);
  });

  it('con conversión encadenada lista el archivo final y espera la conversión', async () => {
    const t = await app();
    const batchId = await openBatch(t, [t.ana.user.id]);
    await download(t, { title: 'Video', batchId, then: { preset: 'mp3' } });
    await download(t, { title: 'Otro', batchId, then: { preset: 'mp3' } });
    await close(t, batchId);
    await waitRuns(t, 1);
    finishRun(t, 0, '.m4a');
    await waitRuns(t, 2);
    finishRun(t, 1, '.m4a');
    await waitRuns(t, 3);
    finishRun(t, 2, '.mp3');
    await flush();
    await flush();
    expect(t.sentMails).toHaveLength(0);
    await waitRuns(t, 4);
    finishRun(t, 3, '.mp3');
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    const text = t.sentMails[0]?.text ?? '';
    expect(t.sentMails[0]?.subject).toBe('Descargas terminadas: 2 de 2 listas');
    expect(text).toContain('- Video → MP3');
    expect(text).toContain('- Otro → MP3');
    expect(text).not.toMatch(/^- Video \(/m);
  });

  it('si al final quedó un solo trabajo, el mail es el de siempre', async () => {
    const t = await app();
    const batchId = await openBatch(t, [t.ana.user.id]);
    await download(t, { title: 'Solo', batchId });
    await close(t, batchId);
    await waitRuns(t, 1);
    finishRun(t, 0);
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    expect(t.sentMails[0]?.subject).toBe('Descarga terminada: Solo');
  });

  it('los cancelados cuentan como terminados y se listan aparte', async () => {
    const t = await app();
    const batchId = await openBatch(t, [t.ana.user.id]);
    const first = await download(t, { title: 'Uno', batchId });
    await download(t, { title: 'Dos', batchId });
    await close(t, batchId);
    await waitRuns(t, 1);
    finishRun(t, 0);
    await waitRuns(t, 2);
    expect(first.jobId).not.toBeNull();
    const second = t.runs[1]?.context.job.id ?? '';
    await t.app.inject({ method: 'POST', url: `/api/jobs/${second}/cancel` });
    t.runs[1]?.reject(new Error('abortado'));
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    expect(t.sentMails[0]?.subject).toBe('Descargas terminadas: 1 de 2 listas');
    expect(t.sentMails[0]?.text).toContain('Canceladas (1):\n- Dos');
  });

  it('un pedido abandonado (la web no lo cerró) se cierra solo y avisa', async () => {
    const t = await app();
    // La cola fecha los trabajos con la hora real: el reloj del pedido también.
    t.clock.now = new Date();
    const batchId = await openBatch(t, [t.ana.user.id]);
    await download(t, { title: 'Uno', batchId });
    await download(t, { title: 'Dos', batchId });
    await waitRuns(t, 1);
    finishRun(t, 0);
    await waitRuns(t, 2);
    finishRun(t, 1);
    await flush();
    t.notifyJob.sweep();
    await flush();
    expect(t.sentMails).toHaveLength(0);

    t.clock.now = new Date(t.clock.now.getTime() + BATCH_GRACE_MS + 60_000);
    t.notifyJob.sweep();
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    expect(t.sentMails[0]?.subject).toBe('Descargas terminadas: 2 de 2 listas');
  });

  it('el pedido es de quien lo abrió; uno cerrado no acepta trabajos nuevos', async () => {
    const t = await app();
    const batchId = await openBatch(t, [t.ana.user.id]);
    const otro = await t.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'https://youtu.be/x', batchId },
      headers: t.beto.headers,
    });
    expect(otro.statusCode).toBe(404);
    expect(otro.json()).toMatchObject({ error: { code: 'BATCH_NOT_FOUND' } });
    const ajeno = await t.app.inject({
      method: 'POST',
      url: `/api/notice-batches/${batchId}/close`,
      headers: t.beto.headers,
    });
    expect(ajeno.statusCode).toBe(404);

    await close(t, batchId);
    const tarde = await download(t, { batchId });
    expect(tarde.response.statusCode).toBe(409);
    expect(tarde.response.json()).toMatchObject({ error: { code: 'BATCH_CLOSED' } });
  });

  it('convertir varios archivos también avisa con un solo mail', async () => {
    const t = await app();
    // Orígenes: dos descargas terminadas, sin aviso.
    await download(t, { title: 'A' });
    await download(t, { title: 'B' });
    await waitRuns(t, 1);
    finishRun(t, 0);
    await waitRuns(t, 2);
    finishRun(t, 1);
    await flush();
    const sources = t.runs.map((run) => run.context.job.id);

    const batchId = await openBatch(t, [t.ana.user.id]);
    for (const sourceJobId of sources) {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/jobs/convert',
        payload: { sourceJobId, preset: 'mp3', batchId },
      });
      expect(response.statusCode).toBe(202);
    }
    await close(t, batchId);
    await waitRuns(t, 3);
    finishRun(t, 2, '.mp3');
    await waitRuns(t, 4);
    finishRun(t, 3, '.mp3');
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    expect(t.sentMails[0]?.subject).toBe('Conversiones terminadas: 2 de 2 listas');
    expect(t.sentMails[0]?.text).toContain('- A → MP3');
  });

  it('si se cancela todo, no avisa (como un trabajo cancelado solo)', async () => {
    const t = await app();
    const batchId = await openBatch(t, [t.ana.user.id]);
    const uno = await download(t, { title: 'Uno', batchId });
    const dos = await download(t, { title: 'Dos', batchId });
    await close(t, batchId);
    await waitRuns(t, 1);
    // El segundo se cancela en cola; el primero, corriendo.
    await t.app.inject({ method: 'POST', url: `/api/jobs/${dos.jobId ?? ''}/cancel` });
    await t.app.inject({ method: 'POST', url: `/api/jobs/${uno.jobId ?? ''}/cancel` });
    t.runs[0]?.reject(new Error('abortado'));
    await vi.waitFor(() => {
      expect(t.repo.get(uno.jobId ?? '')?.status).toBe('cancelled');
    });
    await flush();
    t.notifyJob.sweep();
    await flush();
    expect(t.sentMails).toHaveLength(0);
  });

  it('si el último se cancela mientras espera en cola, el mail sale en el momento', async () => {
    const t = await app();
    const batchId = await openBatch(t, [t.ana.user.id]);
    await download(t, { title: 'Uno', batchId });
    await download(t, { title: 'Dos', batchId });
    const tres = await download(t, { title: 'Tres', batchId });
    await close(t, batchId);
    await waitRuns(t, 1);
    finishRun(t, 0);
    await waitRuns(t, 2);
    // «Tres» todavía está en cola (corre uno a la vez).
    expect(t.repo.get(tres.jobId ?? '')?.status).toBe('queued');
    await t.app.inject({ method: 'POST', url: `/api/jobs/${tres.jobId ?? ''}/cancel` });
    finishRun(t, 1);
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    expect(t.sentMails[0]?.subject).toBe('Descargas terminadas: 2 de 3 listas');
    expect(t.sentMails[0]?.text).toContain('Canceladas (1):\n- Tres');
  });

  it('los trabajos interrumpidos por un reinicio avisan al arrancar', async () => {
    const t = await app();
    const job = await t.queue.enqueue({
      type: 'download',
      params: {},
      title: 'Largo',
      notifyUserIds: [t.ana.user.id],
    });
    await waitRuns(t, 1);
    // Como lo deja `recoverOnStartup` después de un corte.
    t.runs[0]?.reject(new JobError('Se interrumpió porque el servidor se reinició.'));
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    t.sentMails.length = 0;
    const record = t.repo.get(job.id);
    if (!record) throw new Error('falta el job');
    t.notifyJob.notifyInterrupted([record, { ...record, noticeBatchId: 'b' }]);
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    expect(t.sentMails[0]?.subject).toBe('Falló la descarga: Largo');
  });
});

describe('al detener el servicio', () => {
  it('espera los avisos que se están mandando, con un tope', async () => {
    let release: () => void = () => undefined;
    const t = await makeTestApp({
      sendMail: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    storageDirs.push(t.storageDir);
    await t.queue.enqueue({ type: 'download', params: {}, notifyUserIds: [t.ana.user.id] });
    await waitRuns(t as unknown as TestApp, 1);
    t.runs[0]?.reject(new JobError('Se cortó.'));
    await flush();
    await flush();

    let drained = false;
    const draining = t.notifyJob.drain(10_000).then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    release();
    await draining;
    expect(drained).toBe(true);
    // Sin envíos pendientes, vuelve enseguida.
    await t.notifyJob.drain(10_000);
  });
});
