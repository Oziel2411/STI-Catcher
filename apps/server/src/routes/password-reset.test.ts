import { rmSync } from 'node:fs';
import { apiErrorSchema, authOptionsResponseSchema } from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { describeMailError } from '../adapters/mailer.ts';
import { flush, makeTestApp, TEST_PASSWORD } from '../../test/test-app.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NEW_PASSWORD = 'otra-clave-segura-1';
const anonymous = { cookie: '' };

async function app(options: Parameters<typeof makeTestApp>[0] = {}) {
  const testApp = await makeTestApp(options);
  storageDirs.push(testApp.storageDir);
  const forgot = (email: string) =>
    testApp.app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      headers: anonymous,
      payload: { email },
    });
  const reset = (token: string, password = NEW_PASSWORD) =>
    testApp.app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      headers: anonymous,
      payload: { token, password },
    });
  const login = (password: string) =>
    testApp.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: anonymous,
      payload: { email: 'ana@capitanes.ar', password },
    });
  /** El token del último mail mandado. */
  const lastToken = () => {
    const text = testApp.sentMails.at(-1)?.text ?? '';
    const match = /https:\/\/sti\.test\/restablecer#token=([A-Za-z0-9_-]+)/.exec(text);
    if (!match?.[1]) throw new Error('No hay link en el último mail');
    return match[1];
  };
  return { ...testApp, forgot, reset, login, lastToken };
}

describe('GET /api/auth/options', () => {
  it('es público; dice si se puede recuperar la contraseña', async () => {
    const on = await app();
    const response = await on.app.inject({ url: '/api/auth/options', headers: anonymous });
    expect(authOptionsResponseSchema.parse(response.json())).toEqual({ passwordReset: true });

    const off = await app({ publicUrl: null });
    const disabled = await off.app.inject({ url: '/api/auth/options', headers: anonymous });
    expect(disabled.json()).toEqual({ passwordReset: false });
    const forgot = await off.forgot('ana@capitanes.ar');
    expect(forgot.statusCode).toBe(409);
    expect(apiErrorSchema.parse(forgot.json()).error.code).toBe('RESET_DISABLED');
  });
});

describe('POST /api/auth/forgot', () => {
  it('manda un link de un solo uso al mail de la cuenta', async () => {
    const t = await app();
    const response = await t.forgot('  ANA@capitanes.ar ');
    expect(response.statusCode).toBe(202);
    expect(t.sentMails).toHaveLength(1);
    const mail = t.sentMails[0];
    expect(mail?.to).toEqual(['ana@capitanes.ar']);
    expect(mail?.subject).toBe('STI-Catcher: elegí una contraseña nueva');
    expect(mail?.text).toContain('Hola, ana:');
    expect(mail?.text).toContain('vale por 1 hora');
    // El token no sale en la respuesta ni en el log.
    const token = t.lastToken();
    expect(response.body).not.toContain(token);
    expect(JSON.stringify(t.authLogger.info.mock.calls)).not.toContain(token);
  });

  it('con un mail sin cuenta responde igual y no manda nada', async () => {
    const t = await app();
    const known = await t.forgot('ana@capitanes.ar');
    const unknown = await t.forgot('nadie@capitanes.ar');
    expect([unknown.statusCode, unknown.body]).toEqual([known.statusCode, known.body]);
    expect(t.sentMails).toHaveLength(1);
  });

  it('una cuenta desactivada no recibe link', async () => {
    const t = await app();
    const jefa = await t.loginAs('jefa@capitanes.ar', 'admin');
    await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${t.ana.user.id}`,
      headers: jefa.headers,
      payload: { active: false },
    });
    expect((await t.forgot('ana@capitanes.ar')).statusCode).toBe(202);
    expect(t.sentMails).toHaveLength(0);
  });

  it('más de 3 pedidos por hora para el mismo mail: 429, exista o no', async () => {
    const t = await app();
    for (const email of ['ana@capitanes.ar', 'nadie@capitanes.ar']) {
      for (let i = 0; i < 3; i++) expect((await t.forgot(email)).statusCode).toBe(202);
      const response = await t.forgot(email);
      expect(response.statusCode).toBe(429);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('TOO_MANY_REQUESTS');
    }
  });

  it('si el mail no sale, igual responde 202 y queda en el log', async () => {
    const t = await app({ sendMail: () => Promise.reject(describeMailError({ code: 'EAUTH' })) });
    expect((await t.forgot('ana@capitanes.ar')).statusCode).toBe(202);
    await flush();
    expect(t.authLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EAUTH' }),
      'No se pudo enviar el link de recuperación',
    );
  });
});

describe('POST /api/auth/reset', () => {
  it('cambia la contraseña, corta las sesiones y el link no sirve dos veces', async () => {
    const t = await app();
    await t.forgot('ana@capitanes.ar');
    const token = t.lastToken();
    expect((await t.reset(token)).statusCode).toBe(204);
    // La sesión que tenía abierta se cortó.
    expect((await t.app.inject({ url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await t.login(TEST_PASSWORD)).statusCode).toBe(401);
    expect((await t.login(NEW_PASSWORD)).statusCode).toBe(200);

    const again = await t.reset(token, 'una-tercera-clave');
    expect(again.statusCode).toBe(400);
    expect(apiErrorSchema.parse(again.json()).error.code).toBe('INVALID_RESET_LINK');
  });

  it('vence a la hora', async () => {
    const clock = { now: new Date('2026-11-06T10:00:00.000Z') };
    const t = await app({ authNow: () => clock.now });
    await t.forgot('ana@capitanes.ar');
    clock.now = new Date('2026-11-06T11:00:01.000Z');
    expect((await t.reset(t.lastToken())).statusCode).toBe(400);
  });

  it('pedir otro link invalida el anterior', async () => {
    const t = await app();
    await t.forgot('ana@capitanes.ar');
    const first = t.lastToken();
    await t.forgot('ana@capitanes.ar');
    expect((await t.reset(first)).statusCode).toBe(400);
    expect((await t.reset(t.lastToken())).statusCode).toBe(204);
  });

  it('un token inventado no sirve; una contraseña corta tampoco', async () => {
    const t = await app();
    expect((await t.reset('x'.repeat(43))).statusCode).toBe(400);
    await t.forgot('ana@capitanes.ar');
    expect((await t.reset(t.lastToken(), 'corta')).statusCode).toBe(400);
    // El link sigue sirviendo después de un intento con una contraseña corta.
    expect((await t.reset(t.lastToken())).statusCode).toBe(204);
  });

  it('destraba una cuenta bloqueada por intentos fallidos', async () => {
    const t = await app();
    for (let i = 0; i < 5; i++) await t.login('mala-mala-mala');
    expect((await t.login(TEST_PASSWORD)).statusCode).toBe(429);
    await t.forgot('ana@capitanes.ar');
    expect((await t.reset(t.lastToken())).statusCode).toBe(204);
    expect((await t.login(NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('con una contraseña provisoria, el link la reemplaza por una definitiva', async () => {
    const t = await app();
    const jefa = await t.loginAs('jefa@capitanes.ar', 'admin');
    await t.app.inject({
      method: 'POST',
      url: `/api/users/${t.ana.user.id}/password`,
      headers: jefa.headers,
      payload: { password: 'provisoria-123' },
    });
    await t.forgot('ana@capitanes.ar');
    expect((await t.reset(t.lastToken())).statusCode).toBe(204);
    const response = await t.login(NEW_PASSWORD);
    expect(response.json()).toMatchObject({ user: { mustChangePassword: false } });
  });

  it('el log no lleva la contraseña nueva', async () => {
    const t = await app();
    await t.forgot('ana@capitanes.ar');
    await t.reset(t.lastToken());
    const logged = JSON.stringify([t.authLogger.info.mock.calls, t.authLogger.warn.mock.calls]);
    expect(logged).not.toContain(NEW_PASSWORD);
    expect(logged).toContain('Contraseña cambiada con el link de recuperación');
  });
});
