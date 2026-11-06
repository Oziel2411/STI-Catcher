import { rmSync } from 'node:fs';
import {
  apiErrorSchema,
  createJobResponseSchema,
  createRecordingResponseSchema,
  finishRecordingResponseSchema,
  mailStatusResponseSchema,
  mailTestResponseSchema,
  userDirectoryResponseSchema,
} from '@sti-catcher/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, makeTestApp } from '../../test/test-app.ts';
import { describeMailError, MailError } from '../adapters/mailer.ts';
import { JobError } from '../jobs/errors.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app(options: Parameters<typeof makeTestApp>[0] = {}) {
  const testApp = await makeTestApp(options);
  storageDirs.push(testApp.storageDir);
  const beto = await testApp.loginAs('beto@capitanes.ar');
  return { ...testApp, beto };
}
type TestApp = Awaited<ReturnType<typeof app>>;

/** Termina bien el run número `index` (deja un archivo falso). */
function finishRun(t: TestApp, index: number, extension = '.mp4') {
  const run = t.runs[index];
  if (!run) throw new Error(`No hay un job corriendo en la posición ${String(index)}`);
  run.resolve({
    output: { tempPath: `${run.context.job.id}${extension}`, extension },
    metadata: { durationSeconds: 60, resolution: '1280x720', sizeBytes: 2 * 1024 ** 2 },
  });
}

const waitRuns = (t: TestApp, count: number) =>
  vi.waitFor(() => {
    expect(t.runs).toHaveLength(count);
  });

describe('GET /api/mail', () => {
  it('dice si hay servidor de correo y el remitente', async () => {
    const off = await app();
    expect(
      mailStatusResponseSchema.parse((await off.app.inject({ url: '/api/mail' })).json()),
    ).toEqual({ configured: false, from: null });
    const on = await app({ mailConfigured: true });
    expect((await on.app.inject({ url: '/api/mail' })).json()).toEqual({
      configured: true,
      from: 'avisos@capitanes.ar',
    });
  });
});

describe('POST /api/mail/test', () => {
  it('manda el mail de prueba a quien lo pide', async () => {
    const t = await app({ mailConfigured: true });
    const response = await t.app.inject({ method: 'POST', url: '/api/mail/test' });
    expect(response.statusCode).toBe(200);
    expect(mailTestResponseSchema.parse(response.json())).toEqual({ sentTo: 'ana@capitanes.ar' });
    expect(t.sentMails).toHaveLength(1);
    expect(t.sentMails[0]).toMatchObject({
      to: ['ana@capitanes.ar'],
      subject: 'STI-Catcher: mail de prueba',
    });
    expect(t.sentMails[0]?.text).toContain('Hola, ana:');
  });

  it('409 si no está configurado', async () => {
    const t = await app();
    const response = await t.app.inject({ method: 'POST', url: '/api/mail/test' });
    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('MAIL_NOT_CONFIGURED');
  });

  it('502 con el motivo traducido si el servidor de correo falla', async () => {
    const t = await app({
      mailConfigured: true,
      sendMail: () => Promise.reject(describeMailError({ code: 'EAUTH' })),
    });
    const response = await t.app.inject({ method: 'POST', url: '/api/mail/test' });
    expect(response.statusCode).toBe(502);
    const { error } = apiErrorSchema.parse(response.json());
    expect(error.code).toBe('MAIL_EAUTH');
    expect(error.message).toContain('usuario o la contraseña');
  });
});

describe('GET /api/users/directory', () => {
  it('lista las cuentas activas con id y nombre, sin mails (cualquier cuenta)', async () => {
    const t = await app();
    const response = await t.app.inject({ url: '/api/users/directory' });
    expect(response.statusCode).toBe(200);
    const { users } = userDirectoryResponseSchema.parse(response.json());
    expect(users).toEqual([
      { id: t.ana.user.id, name: 'ana' },
      { id: t.beto.user.id, name: 'beto' },
    ]);
    expect(response.body).not.toContain('@capitanes.ar');
  });
});

describe('avisos por mail al terminar o fallar (D-104)', () => {
  it('grabación: avisa a las cuentas elegidas al empezar, cuando termina', async () => {
    const t = await app();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/recordings',
      payload: {
        mimeType: 'video/webm;codecs=vp9,opus',
        fps: 30,
        title: 'Clase de radar',
        notify: [t.ana.user.id, t.beto.user.id, t.ana.user.id],
      },
    });
    const { recordingId } = createRecordingResponseSchema.parse(created.json());
    await t.app.inject({
      method: 'POST',
      url: `/api/recordings/${recordingId}/chunks?seq=0`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(100),
    });
    const finished = await t.app.inject({
      method: 'POST',
      url: `/api/recordings/${recordingId}/finish`,
    });
    const { jobId } = finishRecordingResponseSchema.parse(finished.json());
    expect(t.repo.get(jobId)?.notifyUserIds).toEqual([t.ana.user.id, t.beto.user.id]);
    await waitRuns(t, 1);
    finishRun(t, 0);
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    const mail = t.sentMails[0];
    expect(mail?.to).toEqual(['ana@capitanes.ar', 'beto@capitanes.ar']);
    expect(mail?.subject).toBe('Grabación terminada: Clase de radar');
    expect(mail?.text).toContain('Duración: 1:00');
    expect(mail?.text).toContain('Pedida por: ana (desde 127.0.0.1)');
    expect(mail?.text).toContain('Historial: https://sti.test/historial');
  });

  it('descarga fallida: avisa con el motivo', async () => {
    const t = await app();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'https://youtu.be/x', title: 'Video', notify: [t.beto.user.id] },
    });
    createJobResponseSchema.parse(created.json());
    await waitRuns(t, 1);
    t.runs[0]?.reject(new JobError('El video no existe o fue eliminado.'));
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    expect(t.sentMails[0]?.to).toEqual(['beto@capitanes.ar']);
    expect(t.sentMails[0]?.subject).toBe('Falló la descarga: Video');
    expect(t.sentMails[0]?.text).toContain('Motivo: El video no existe o fue eliminado.');
  });

  it('descarga con conversión encadenada: avisa una sola vez, la conversión', async () => {
    const t = await app();
    await t.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: {
        url: 'https://youtu.be/x',
        title: 'Video',
        then: { preset: 'mp3' },
        notify: [t.ana.user.id],
      },
    });
    await waitRuns(t, 1);
    finishRun(t, 0, '.m4a');
    await waitRuns(t, 2);
    await flush();
    expect(t.sentMails).toHaveLength(0);
    finishRun(t, 1, '.mp3');
    await vi.waitFor(() => {
      expect(t.sentMails).toHaveLength(1);
    });
    expect(t.sentMails[0]?.subject).toMatch(/^Conversión terminada: /);
  });

  it('sin nadie elegido, cancelado o selftest: no avisa', async () => {
    const t = await app();
    await t.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'https://youtu.be/x' },
    });
    await waitRuns(t, 1);
    finishRun(t, 0);
    const cancelled = await t.queue.enqueue({
      type: 'download',
      params: {},
      notifyUserIds: [t.ana.user.id],
    });
    t.queue.cancel(cancelled.id);
    await t.app.inject({ method: 'POST', url: '/api/jobs/selftest' });
    await waitRuns(t, 2);
    t.runs[1]?.resolve({ output: null });
    await flush();
    await flush();
    expect(t.sentMails).toHaveLength(0);
  });

  it('una cuenta desactivada no recibe el aviso; si nadie queda, no se manda', async () => {
    const t = await app();
    const jefa = await t.loginAs('jefa@capitanes.ar', 'admin');
    await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${t.beto.user.id}`,
      headers: jefa.headers,
      payload: { active: false },
    });
    await t.queue.enqueue({ type: 'download', params: {}, notifyUserIds: [t.beto.user.id] });
    await waitRuns(t, 1);
    finishRun(t, 0);
    await flush();
    await flush();
    expect(t.sentMails).toHaveLength(0);
  });

  it('si el mail falla, queda en el log y el trabajo igual termina', async () => {
    const t = await app({
      sendMail: () => Promise.reject(new MailError('ESOCKET', 'Se cortó la conexión')),
    });
    const job = await t.queue.enqueue({
      type: 'recording',
      params: {},
      notifyUserIds: [t.ana.user.id],
    });
    await waitRuns(t, 1);
    finishRun(t, 0);
    await vi.waitFor(() => {
      expect(t.noticeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id, code: 'ESOCKET' }),
        'No se pudo enviar el aviso por mail',
      );
    });
    expect(t.queue.get(job.id)?.status).toBe('done');
  });

  it('reintentar avisa a los mismos que el original', async () => {
    const t = await app();
    await t.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'https://youtu.be/x', notify: [t.beto.user.id] },
    });
    await waitRuns(t, 1);
    const original = t.runs[0]?.context.job.id ?? '';
    t.runs[0]?.reject(new JobError('falló'));
    await vi.waitFor(() => {
      expect(t.queue.get(original)?.status).toBe('failed');
    });
    const retry = await t.app.inject({ method: 'POST', url: `/api/jobs/${original}/retry` });
    const { jobId } = createJobResponseSchema.parse(retry.json());
    expect(t.repo.get(jobId)?.notifyUserIds).toEqual([t.beto.user.id]);
  });

  it('400 con algo que no es un id de cuenta en `notify`', async () => {
    const t = await app();
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'https://youtu.be/x', notify: ['beto@capitanes.ar'] },
    });
    expect(response.statusCode).toBe(400);
  });
});
