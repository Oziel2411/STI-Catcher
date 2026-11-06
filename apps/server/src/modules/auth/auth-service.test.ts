import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/connection.ts';
import { migrate } from '../../db/migrate.ts';
import { migrations } from '../../db/migrations.ts';
import { createSessionsRepository } from '../../db/sessions-repository.ts';
import { createUsersRepository } from '../../db/users-repository.ts';
import { AuthError, createAuthService, hashToken } from './auth-service.ts';
import { createLoginLimiter } from './login-limiter.ts';

const PASSWORD = 'contraseña-de-prueba';
const HOUR = 60 * 60_000;

function setup() {
  const db = openDatabase(':memory:');
  migrate(db, migrations);
  const clock = { now: new Date('2026-11-06T12:00:00.000Z') };
  const users = createUsersRepository(db);
  const sessions = createSessionsRepository(db);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const verify = vi.fn((password: string, stored: string) =>
    Promise.resolve(stored === `fake$${password}`),
  );
  const auth = createAuthService({
    users,
    sessions,
    limiter: createLoginLimiter({ now: () => clock.now.getTime() }),
    logger,
    now: () => clock.now,
    hash: (password) => Promise.resolve(`fake$${password}`),
    verify,
  });
  return { db, clock, users, sessions, logger, verify, auth };
}

async function withUser() {
  const ctx = setup();
  const user = await ctx.auth.createUser({
    email: '  Ana@Capitanes.AR ',
    name: ' Ana ',
    role: 'user',
    password: PASSWORD,
  });
  return { ...ctx, user };
}

const fail = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('se esperaba un error');
    },
    (error: unknown) => error as AuthError,
  );

describe('createUser', () => {
  it('guarda el mail en minúsculas y el nombre sin espacios', async () => {
    const { user } = await withUser();
    expect(user).toMatchObject({
      email: 'ana@capitanes.ar',
      name: 'Ana',
      role: 'user',
      active: true,
      mustChangePassword: false,
    });
  });

  it('rechaza un mail repetido (sin distinguir mayúsculas) y una contraseña corta', async () => {
    const { auth } = await withUser();
    const repeated = await fail(
      auth.createUser({ email: 'ANA@capitanes.ar', name: 'X', role: 'user', password: PASSWORD }),
    );
    expect(repeated.code).toBe('EMAIL_TAKEN');
    const weak = await fail(
      auth.createUser({ email: 'b@capitanes.ar', name: 'B', role: 'user', password: 'corta' }),
    );
    expect(weak.code).toBe('WEAK_PASSWORD');
    expect(weak.message).toContain('10 caracteres');
  });
});

describe('login', () => {
  it('abre una sesión: en la base queda el SHA-256 del token, nunca el token', async () => {
    const { auth, db, user } = await withUser();
    const { token, user: sessionUser } = await auth.login(
      { email: 'ana@capitanes.ar', password: PASSWORD },
      '10.0.0.1',
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionUser).toEqual({
      id: user.id,
      email: 'ana@capitanes.ar',
      name: 'Ana',
      role: 'user',
      mustChangePassword: false,
    });
    const rows = db.prepare('SELECT token_hash, ip FROM sessions').all();
    expect(rows).toEqual([{ token_hash: hashToken(token), ip: '10.0.0.1' }]);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(auth.authenticate(token)?.user.id).toBe(user.id);
  });

  it('cada ingreso da un token distinto', async () => {
    const { auth } = await withUser();
    const a = await auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip');
    const b = await auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip');
    expect(a.token).not.toBe(b.token);
  });

  it('mismo error con un mail que no existe y con una contraseña mala; igual se calcula el hash', async () => {
    const { auth, verify, logger } = await withUser();
    const unknown = await fail(auth.login({ email: 'nadie@capitanes.ar', password: 'x' }, 'ip'));
    const wrong = await fail(auth.login({ email: 'ana@capitanes.ar', password: 'x' }, 'ip'));
    expect(unknown).toBeInstanceOf(AuthError);
    expect([unknown.code, unknown.message, unknown.status]).toEqual([
      wrong.code,
      wrong.message,
      wrong.status,
    ]);
    expect(unknown.message).toBe('Mail o contraseña incorrectos.');
    // El mail inexistente también pasó por verify (el tiempo no lo delata).
    expect(verify).toHaveBeenCalledTimes(2);
    // El log dice el motivo, pero nunca la contraseña.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'nadie@capitanes.ar', reason: 'unknown' }),
      'Ingreso fallido',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('"x"');
  });

  it('una cuenta desactivada no entra y sus sesiones dejan de valer', async () => {
    const { auth, db, user } = await withUser();
    const { token } = await auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip');
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);
    expect(auth.authenticate(token)).toBeNull();
    const error = await fail(auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip'));
    expect(error.code).toBe('INVALID_CREDENTIALS');
  });

  it('tras 5 fallidos, ni la contraseña correcta entra hasta que pasen 15 minutos', async () => {
    const { auth, clock } = await withUser();
    for (let i = 0; i < 5; i++) {
      await fail(auth.login({ email: 'ana@capitanes.ar', password: 'mala' }, 'ip'));
    }
    const blocked = await fail(auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip'));
    expect(blocked.code).toBe('TOO_MANY_ATTEMPTS');
    expect(blocked.status).toBe(429);
    expect(blocked.message).toContain('15 minutos');
    clock.now = new Date(clock.now.getTime() + 15 * 60_000 + 1);
    await expect(
      auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip'),
    ).resolves.toBeTruthy();
  });
});

describe('authenticate', () => {
  it('corta la sesión tras 12 h sin uso; el uso la mantiene viva', async () => {
    const { auth, clock } = await withUser();
    const { token } = await auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip');
    // Usada cada 11 h durante dos días: sigue valiendo.
    for (let i = 0; i < 4; i++) {
      clock.now = new Date(clock.now.getTime() + 11 * HOUR);
      expect(auth.authenticate(token)).not.toBeNull();
    }
    clock.now = new Date(clock.now.getTime() + 12 * HOUR + 1);
    expect(auth.authenticate(token)).toBeNull();
    // Y ya se borró: no revive.
    clock.now = new Date(clock.now.getTime() - 12 * HOUR);
    expect(auth.authenticate(token)).toBeNull();
  });

  it('un token inventado, vacío o null no autentica', async () => {
    const { auth } = await withUser();
    expect(auth.authenticate('inventado')).toBeNull();
    expect(auth.authenticate('')).toBeNull();
    expect(auth.authenticate(null)).toBeNull();
  });

  it('logout borra la sesión', async () => {
    const { auth } = await withUser();
    const { token } = await auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip');
    auth.logout(token);
    expect(auth.authenticate(token)).toBeNull();
  });

  it('al ingresar se limpian las sesiones abandonadas', async () => {
    const { auth, clock, db } = await withUser();
    await auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip');
    clock.now = new Date(clock.now.getTime() + 13 * HOUR);
    await auth.login({ email: 'ana@capitanes.ar', password: PASSWORD }, 'ip');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });
});
