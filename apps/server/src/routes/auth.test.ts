import { rmSync } from 'node:fs';
import { apiErrorSchema, meResponseSchema } from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, TEST_PASSWORD } from '../../test/test-app.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app(options: Parameters<typeof makeTestApp>[0] = {}) {
  const testApp = await makeTestApp(options);
  storageDirs.push(testApp.storageDir);
  return testApp;
}

/** Sin la sesión por defecto de la app de prueba. */
const anonymous = { cookie: '' };

const login = (testApp: Awaited<ReturnType<typeof app>>, email: string, password: string) =>
  testApp.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: anonymous,
    payload: { email, password },
  });

describe('login obligatorio', () => {
  it('sin sesión la API responde 401, salvo ingresar y /api/health', async () => {
    const testApp = await app();
    for (const [method, url] of [
      ['GET', '/api/history'],
      ['GET', '/api/auth/me'],
      ['GET', '/api/active-jobs'],
      ['POST', '/api/jobs/selftest'],
      ['DELETE', '/api/jobs/00000000-0000-4000-8000-999999999999'],
    ] as const) {
      const response = await testApp.app.inject({ method, url, headers: anonymous });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(apiErrorSchema.parse(response.json()).error).toEqual({
        code: 'UNAUTHENTICATED',
        message: 'Tenés que ingresar para usar STI-Catcher.',
      });
    }
    expect(
      (await testApp.app.inject({ method: 'GET', url: '/api/health', headers: anonymous }))
        .statusCode,
    ).toBe(200);
  });

  it('una cookie inventada tampoco entra', async () => {
    const testApp = await app();
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/history',
      headers: { cookie: 'sti_session=inventada' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/auth/login', () => {
  it('abre la sesión con una cookie HttpOnly, SameSite=Lax y sin vencimiento', async () => {
    const testApp = await app();
    await testApp.loginAs('beto@capitanes.ar');
    const response = await login(testApp, '  BETO@capitanes.ar ', TEST_PASSWORD);
    expect(response.statusCode).toBe(200);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(/^sti_session=[A-Za-z0-9_-]{43}; /);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    // Cookie de sesión: dura hasta cerrar el navegador.
    expect(setCookie).not.toMatch(/Max-Age|Expires/i);
    expect(setCookie).not.toContain('Secure'); // sin HTTPS
    const body = meResponseSchema.parse(response.json());
    expect(body.user).toMatchObject({ email: 'beto@capitanes.ar', name: 'beto', role: 'user' });
    // Nada de la contraseña ni del token en el cuerpo.
    expect(response.body).not.toContain(TEST_PASSWORD);
    expect(response.body).not.toContain('fake$');
    expect(response.body).not.toContain(setCookie.split(';')[0]?.split('=')[1] ?? '-');

    const me = await testApp.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: setCookie.split(';')[0] ?? '' },
    });
    expect(meResponseSchema.parse(me.json()).user.email).toBe('beto@capitanes.ar');
  });

  it('401 con la contraseña mala o un mail que no existe, con el mismo mensaje', async () => {
    const testApp = await app();
    const wrong = await login(testApp, 'ana@capitanes.ar', 'otra-contraseña');
    const unknown = await login(testApp, 'nadie@capitanes.ar', TEST_PASSWORD);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('429 después de 5 intentos fallidos', async () => {
    const testApp = await app();
    for (let i = 0; i < 5; i++) await login(testApp, 'ana@capitanes.ar', 'mala-mala-mala');
    const response = await login(testApp, 'ana@capitanes.ar', TEST_PASSWORD);
    expect(response.statusCode).toBe(429);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('400 si falta algo o el mail no es un mail', async () => {
    const testApp = await app();
    expect((await login(testApp, 'no-es-mail', 'x')).statusCode).toBe(400);
    expect((await login(testApp, 'ana@capitanes.ar', '')).statusCode).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  it('borra la cookie y la sesión deja de valer', async () => {
    const testApp = await app();
    const { headers } = await testApp.loginAs('beto@capitanes.ar');
    const response = await testApp.app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
    const after = await testApp.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(after.statusCode).toBe(401);
  });
});

describe('sesión', () => {
  it('se corta tras 12 h sin uso', async () => {
    const clock = { now: new Date('2026-11-06T08:00:00.000Z') };
    const testApp = await app({ authNow: () => clock.now });
    expect((await testApp.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);
    clock.now = new Date('2026-11-06T20:00:01.000Z');
    expect((await testApp.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
  });
});

describe('origen de los pedidos', () => {
  it('rechaza un POST que viene de otro sitio; acepta el propio', async () => {
    const testApp = await app();
    const foreign = await testApp.app.inject({
      method: 'POST',
      url: '/api/jobs/selftest',
      headers: { origin: 'https://otro-sitio.com' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(apiErrorSchema.parse(foreign.json()).error.code).toBe('BAD_ORIGIN');

    const own = await testApp.app.inject({
      method: 'POST',
      url: '/api/jobs/selftest',
      headers: { origin: 'https://192.168.3.115:3000', host: '192.168.3.115:3000' },
    });
    expect(own.statusCode).toBe(202);
  });
});
