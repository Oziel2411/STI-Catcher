import { rmSync } from 'node:fs';
import {
  apiErrorSchema,
  mailStatusResponseSchema,
  mailTestResponseSchema,
} from '@sti-catcher/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, makeTestApp } from '../../test/test-app.ts';
import { describeMailError } from '../adapters/mailer.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app(options: Parameters<typeof makeTestApp>[0] = {}) {
  const testApp = await makeTestApp(options);
  storageDirs.push(testApp.storageDir);
  return testApp;
}

describe('GET /api/mail', () => {
  it('sin SMTP: no configurado', async () => {
    const testApp = await app();
    const response = await testApp.app.inject({ method: 'GET', url: '/api/mail' });
    expect(mailStatusResponseSchema.parse(response.json())).toEqual({
      configured: false,
      from: null,
      recipients: 0,
    });
  });

  it('configurado: remitente y cuántos destinatarios, sin las direcciones', async () => {
    const testApp = await app({ mailTo: ['a@capitanes.ar', 'b@capitanes.ar'] });
    const response = await testApp.app.inject({ method: 'GET', url: '/api/mail' });
    expect(response.json()).toEqual({
      configured: true,
      from: 'avisos@capitanes.ar',
      recipients: 2,
    });
    expect(response.body).not.toContain('a@capitanes.ar');
  });
});

describe('POST /api/mail/test', () => {
  it('manda un mail de prueba a los destinatarios', async () => {
    const testApp = await app({ mailTo: ['a@capitanes.ar'] });
    const response = await testApp.app.inject({ method: 'POST', url: '/api/mail/test' });
    expect(response.statusCode).toBe(200);
    expect(mailTestResponseSchema.parse(response.json())).toEqual({ sentTo: 1 });
    expect(testApp.sentMails).toHaveLength(1);
    expect(testApp.sentMails[0]).toMatchObject({
      to: ['a@capitanes.ar'],
      subject: 'STI-Catcher: mail de prueba',
    });
  });

  it('409 si no está configurado', async () => {
    const testApp = await app();
    const response = await testApp.app.inject({ method: 'POST', url: '/api/mail/test' });
    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('MAIL_NOT_CONFIGURED');
  });

  it('502 con el motivo traducido si el servidor de correo falla', async () => {
    const testApp = await app({
      mailTo: ['a@capitanes.ar'],
      sendMail: () => Promise.reject(describeMailError({ code: 'EAUTH' })),
    });
    const response = await testApp.app.inject({ method: 'POST', url: '/api/mail/test' });
    expect(response.statusCode).toBe(502);
    const { error } = apiErrorSchema.parse(response.json());
    expect(error.code).toBe('MAIL_EAUTH');
    expect(error.message).toContain('usuario o la contraseña');
  });
});

describe('aviso al terminar una grabación', () => {
  it('la cola manda el mail cuando un job de grabación termina bien (y no por otros)', async () => {
    const testApp = await app({ mailTo: ['a@capitanes.ar'] });
    const recording = await testApp.queue.enqueue({
      type: 'recording',
      params: {},
      title: 'Clase de radar',
    });
    await flush();
    testApp.runs[0]?.resolve({
      output: { tempPath: `${recording.id}.mp4`, extension: '.mp4' },
      metadata: { durationSeconds: 60, resolution: '1280x720' },
    });
    await vi.waitFor(() => {
      expect(testApp.sentMails).toHaveLength(1);
    });
    expect(testApp.sentMails[0]?.subject).toBe('Grabación terminada: Clase de radar');
    expect(testApp.sentMails[0]?.text).toContain('Duración: 1:00');

    const other = await testApp.queue.enqueue({ type: 'selftest', params: {} });
    await vi.waitFor(() => {
      expect(testApp.runs).toHaveLength(2);
    });
    testApp.runs[1]?.resolve({ output: null });
    await vi.waitFor(() => {
      expect(testApp.queue.get(other.id)?.status).toBe('done');
    });
    expect(testApp.sentMails).toHaveLength(1);
  });
});
