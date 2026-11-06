import { rmSync } from 'node:fs';
import {
  apiErrorSchema,
  historyResponseSchema,
  meResponseSchema,
  userResponseSchema,
  usersResponseSchema,
} from '@sti-catcher/shared';
import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, TEST_PASSWORD } from '../../test/test-app.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROVISIONAL = 'provisoria-123';
const NEW_PASSWORD = 'mi-clave-nueva-456';

async function app() {
  const testApp = await makeTestApp();
  storageDirs.push(testApp.storageDir);
  // «ana» (la sesión por defecto) es usuaria común; «jefa» es administradora.
  const jefa = await testApp.loginAs('jefa@capitanes.ar', 'admin');
  const inject = (opts: InjectOptions) => testApp.app.inject(opts);
  const asJefa = (opts: InjectOptions) =>
    inject({ ...opts, headers: { ...jefa.headers, ...opts.headers } });
  const login = (email: string, password: string) =>
    inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: '' },
      payload: { email, password },
    });
  /** Cookie de la respuesta de un ingreso. */
  const cookieOf = (response: Awaited<ReturnType<typeof login>>) => ({
    cookie: String(response.headers['set-cookie']).split(';')[0] ?? '',
  });
  const createUser = async (email: string, role: 'admin' | 'user' = 'user') => {
    const response = await asJefa({
      method: 'POST',
      url: '/api/users',
      payload: { email, name: `Nombre de ${email}`, role, password: PROVISIONAL },
    });
    expect(response.statusCode).toBe(201);
    return userResponseSchema.parse(response.json()).user;
  };
  return { ...testApp, jefa, asJefa, login, cookieOf, createUser };
}

const errorCode = (response: { json: () => unknown }) =>
  apiErrorSchema.parse(response.json()).error.code;

describe('administración de cuentas', () => {
  it('solo un admin puede listar, crear, modificar o poner contraseñas', async () => {
    const t = await app();
    const target = t.ana.user.id;
    for (const [method, url, payload] of [
      ['GET', '/api/users', undefined],
      ['POST', '/api/users', { email: 'x@capitanes.ar', name: 'X', password: PROVISIONAL }],
      ['PATCH', `/api/users/${target}`, { name: 'Otro' }],
      ['POST', `/api/users/${target}/password`, { password: PROVISIONAL }],
    ] as const) {
      const response = await t.app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(errorCode(response)).toBe('FORBIDDEN');
    }
  });

  it('lista las cuentas sin hashes', async () => {
    const t = await app();
    const response = await t.asJefa({ method: 'GET', url: '/api/users' });
    expect(response.statusCode).toBe(200);
    const { users } = usersResponseSchema.parse(response.json());
    expect(users.map((u) => [u.email, u.role, u.active])).toEqual([
      ['ana@capitanes.ar', 'user', true],
      ['jefa@capitanes.ar', 'admin', true],
    ]);
    expect(response.body).not.toContain('fake$');
    expect(response.body).not.toContain('password');
  });

  it('crea una cuenta con contraseña provisoria; mail repetido 409, contraseña corta 400', async () => {
    const t = await app();
    const user = await t.createUser('Nuevo@Capitanes.ar');
    expect(user).toMatchObject({
      email: 'nuevo@capitanes.ar',
      role: 'user',
      active: true,
      mustChangePassword: true,
      lastLoginAt: null,
    });
    const repeated = await t.asJefa({
      method: 'POST',
      url: '/api/users',
      payload: { email: 'nuevo@capitanes.ar', name: 'Otro', password: PROVISIONAL },
    });
    expect(repeated.statusCode).toBe(409);
    expect(errorCode(repeated)).toBe('EMAIL_TAKEN');
    const weak = await t.asJefa({
      method: 'POST',
      url: '/api/users',
      payload: { email: 'otro@capitanes.ar', name: 'Otro', password: 'corta' },
    });
    expect(weak.statusCode).toBe(400);
  });

  it('desactivar corta sus sesiones y ya no puede ingresar; reactivar lo deja volver', async () => {
    const t = await app();
    const deactivate = await t.asJefa({
      method: 'PATCH',
      url: `/api/users/${t.ana.user.id}`,
      payload: { active: false },
    });
    expect(userResponseSchema.parse(deactivate.json()).user.active).toBe(false);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await t.login('ana@capitanes.ar', TEST_PASSWORD)).statusCode).toBe(401);

    await t.asJefa({
      method: 'PATCH',
      url: `/api/users/${t.ana.user.id}`,
      payload: { active: true },
    });
    expect((await t.login('ana@capitanes.ar', TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('cambia nombre y rol; el nombre nuevo se ve en el historial', async () => {
    const t = await app();
    await t.app.inject({ method: 'POST', url: '/api/jobs/download', payload: { url: 'x' } });
    const response = await t.asJefa({
      method: 'PATCH',
      url: `/api/users/${t.ana.user.id}`,
      payload: { name: 'Ana Pérez', role: 'admin' },
    });
    expect(userResponseSchema.parse(response.json()).user).toMatchObject({
      name: 'Ana Pérez',
      role: 'admin',
    });
    // Ahora ana puede administrar.
    expect((await t.app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(200);
  });

  it('un admin no puede quitarse el rol ni desactivarse a sí mismo', async () => {
    const t = await app();
    for (const payload of [{ role: 'user' }, { active: false }]) {
      const response = await t.asJefa({
        method: 'PATCH',
        url: `/api/users/${t.jefa.user.id}`,
        payload,
      });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('SELF_CHANGE');
    }
    // Su propio nombre sí.
    const rename = await t.asJefa({
      method: 'PATCH',
      url: `/api/users/${t.jefa.user.id}`,
      payload: { name: 'La Jefa' },
    });
    expect(rename.statusCode).toBe(200);
  });

  it('404 con una cuenta que no existe; 400 con un id inválido o sin cambios', async () => {
    const t = await app();
    const missing = await t.asJefa({
      method: 'PATCH',
      url: '/api/users/00000000-0000-4000-8000-999999999999',
      payload: { name: 'X' },
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await t.asJefa({
      method: 'PATCH',
      url: '/api/users/nada',
      payload: { name: 'X' },
    });
    expect(invalid.statusCode).toBe(400);
    const empty = await t.asJefa({
      method: 'PATCH',
      url: `/api/users/${t.ana.user.id}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe('contraseña provisoria', () => {
  it('con provisoria solo se puede cambiarla; después se usa la app normalmente', async () => {
    const t = await app();
    await t.createUser('nuevo@capitanes.ar');
    const first = await t.login('nuevo@capitanes.ar', PROVISIONAL);
    expect(meResponseSchema.parse(first.json()).user.mustChangePassword).toBe(true);
    const headers = t.cookieOf(first);

    const blocked = await t.app.inject({ method: 'GET', url: '/api/history', headers });
    expect(blocked.statusCode).toBe(403);
    expect(errorCode(blocked)).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(
      200,
    );

    const changed = await t.app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers,
      payload: { currentPassword: PROVISIONAL, newPassword: NEW_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    expect(meResponseSchema.parse(changed.json()).user.mustChangePassword).toBe(false);
    // La sesión actual sigue y ya puede usar la app.
    expect((await t.app.inject({ method: 'GET', url: '/api/history', headers })).statusCode).toBe(
      200,
    );
    expect((await t.login('nuevo@capitanes.ar', PROVISIONAL)).statusCode).toBe(401);
    expect((await t.login('nuevo@capitanes.ar', NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('el admin pone una provisoria: corta las sesiones de esa cuenta', async () => {
    const t = await app();
    const response = await t.asJefa({
      method: 'POST',
      url: `/api/users/${t.ana.user.id}/password`,
      payload: { password: PROVISIONAL },
    });
    expect(userResponseSchema.parse(response.json()).user.mustChangePassword).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await t.login('ana@capitanes.ar', TEST_PASSWORD)).statusCode).toBe(401);
    const again = await t.login('ana@capitanes.ar', PROVISIONAL);
    expect(meResponseSchema.parse(again.json()).user.mustChangePassword).toBe(true);
  });
});

describe('Mi cuenta', () => {
  it('cambia el propio nombre', async () => {
    const t = await app();
    await t.app.inject({ method: 'POST', url: '/api/jobs/download', payload: { url: 'x' } });
    const response = await t.app.inject({
      method: 'PATCH',
      url: '/api/me',
      payload: { name: '  Ana María  ' },
    });
    expect(meResponseSchema.parse(response.json()).user.name).toBe('Ana María');
    const history = historyResponseSchema.parse(
      (await t.app.inject({ method: 'GET', url: '/api/history' })).json(),
    );
    for (const item of history.items) expect(item.requester).toBe('Ana María');
    const blank = await t.app.inject({ method: 'PATCH', url: '/api/me', payload: { name: ' ' } });
    expect(blank.statusCode).toBe(400);
  });

  it('cambiar la contraseña pide la actual y corta las demás sesiones', async () => {
    const t = await app();
    const other = await t.loginAs('ana@capitanes.ar'); // otra PC
    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/me/password',
      payload: { currentPassword: 'no-es-esta', newPassword: NEW_PASSWORD },
    });
    expect(wrong.statusCode).toBe(400);
    expect(errorCode(wrong)).toBe('WRONG_PASSWORD');
    const same = await t.app.inject({
      method: 'POST',
      url: '/api/me/password',
      payload: { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD },
    });
    expect(errorCode(same)).toBe('SAME_PASSWORD');
    const short = await t.app.inject({
      method: 'POST',
      url: '/api/me/password',
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'corta' },
    });
    expect(short.statusCode).toBe(400);

    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/me/password',
      payload: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: other.headers }))
        .statusCode,
    ).toBe(401);
  });

  it('5 contraseñas actuales mal seguidas bloquean el cambio (429)', async () => {
    const t = await app();
    const attempt = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/me/password',
        payload: { currentPassword: 'no-es-esta', newPassword: NEW_PASSWORD },
      });
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(400);
    expect((await attempt()).statusCode).toBe(429);
  });

  it('el log no lleva contraseñas', async () => {
    const t = await app();
    await t.createUser('nuevo@capitanes.ar');
    await t.app.inject({
      method: 'POST',
      url: '/api/me/password',
      payload: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });
    const logged = JSON.stringify([t.authLogger.info.mock.calls, t.authLogger.warn.mock.calls]);
    expect(logged).not.toContain(PROVISIONAL);
    expect(logged).not.toContain(NEW_PASSWORD);
    expect(logged).not.toContain(TEST_PASSWORD);
    expect(logged).toContain('Contraseña cambiada');
  });
});
