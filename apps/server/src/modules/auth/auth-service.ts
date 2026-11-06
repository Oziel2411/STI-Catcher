import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@sti-catcher/shared';
import type { LoginRequest, SessionUser, UserRole } from '@sti-catcher/shared';
import type { SessionsRepository } from '../../db/sessions-repository.ts';
import type { UserRecord, UsersRepository } from '../../db/users-repository.ts';
import type { LoginLimiter } from './login-limiter.ts';
import { hashPassword, verifyPassword } from './password.ts';

/** Error con mensaje para el usuario; las rutas lo traducen al código HTTP. */
export class AuthError extends Error {
  override name = 'AuthError';
  constructor(
    readonly code: 'INVALID_CREDENTIALS' | 'TOO_MANY_ATTEMPTS' | 'EMAIL_TAKEN' | 'WEAK_PASSWORD',
    message: string,
    readonly status: 400 | 401 | 409 | 429,
  ) {
    super(message);
  }
}

export type AuthServiceDeps = {
  users: UsersRepository;
  sessions: SessionsRepository;
  limiter: LoginLimiter;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
  /** Sin actividad por más de esto, la sesión se corta (D-100: 12 h). */
  idleMs?: number;
  now?: () => Date;
  /** Inyectables para que los tests no paguen el costo de scrypt. */
  hash?: (password: string) => Promise<string>;
  verify?: (password: string, stored: string) => Promise<boolean>;
};

export type AuthenticatedSession = { user: UserRecord; tokenHash: string };

const DEFAULT_IDLE_MS = 12 * 60 * 60_000;
/** No se escribe `last_seen_at` en cada request: con una vez por minuto alcanza. */
const TOUCH_EVERY_MS = 60_000;

/** El token viaja en la cookie; en la base, solo su SHA-256. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const toSessionUser = (user: UserRecord): SessionUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  mustChangePassword: user.mustChangePassword,
});

const INVALID_MESSAGE = 'Mail o contraseña incorrectos.';

/** Valida una contraseña nueva. Lanza AuthError con el motivo. */
export function assertPasswordStrength(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AuthError(
      'WEAK_PASSWORD',
      `La contraseña tiene que tener al menos ${String(PASSWORD_MIN_LENGTH)} caracteres.`,
      400,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new AuthError(
      'WEAK_PASSWORD',
      `La contraseña puede tener hasta ${String(PASSWORD_MAX_LENGTH)} caracteres.`,
      400,
    );
  }
}

/**
 * Cuentas y sesiones (D-100). No conoce Fastify: las rutas leen la cookie y
 * le pasan el token.
 */
export function createAuthService(deps: AuthServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const hash = deps.hash ?? ((password: string) => hashPassword(password));
  const verify = deps.verify ?? verifyPassword;
  // Con un mail que no existe igual se calcula un scrypt: el tiempo de
  // respuesta no delata qué mails tienen cuenta.
  let dummyHash: Promise<string> | null = null;
  const getDummyHash = () => (dummyHash ??= hash(randomUUID()));

  return {
    async login(input: LoginRequest, ip: string) {
      const email = input.email;
      const waitMs = deps.limiter.blockedFor(email, ip);
      if (waitMs > 0) {
        const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
        throw new AuthError(
          'TOO_MANY_ATTEMPTS',
          `Demasiados intentos fallidos. Probá de nuevo en ${String(minutes)} ${minutes === 1 ? 'minuto' : 'minutos'}.`,
          429,
        );
      }

      const user = deps.users.findByEmail(email);
      const ok = user
        ? await verify(input.password, user.passwordHash)
        : (await verify(input.password, await getDummyHash()), false);
      if (!user || !ok || !user.active) {
        deps.limiter.recordFailure(email, ip);
        deps.logger.warn(
          { email, ip, reason: !user ? 'unknown' : !ok ? 'password' : 'inactive' },
          'Ingreso fallido',
        );
        throw new AuthError('INVALID_CREDENTIALS', INVALID_MESSAGE, 401);
      }

      deps.limiter.recordSuccess(email);
      const at = now().toISOString();
      // Limpieza de paso: las sesiones abandonadas no se acumulan.
      deps.sessions.deleteIdle(new Date(now().getTime() - idleMs).toISOString());
      // Token nuevo en cada ingreso (evita fijación de sesión).
      const token = randomBytes(32).toString('base64url');
      deps.sessions.insert({
        tokenHash: hashToken(token),
        userId: user.id,
        createdAt: at,
        lastSeenAt: at,
        ip,
      });
      deps.users.setLastLogin(user.id, at);
      deps.logger.info({ userId: user.id, email: user.email, ip }, 'Ingreso');
      return { token, user: toSessionUser(user) };
    },

    /** La sesión de un token, o null si no existe, venció o la cuenta está desactivada. */
    authenticate(token: string | null): AuthenticatedSession | null {
      if (token === null || token === '') return null;
      const tokenHash = hashToken(token);
      const session = deps.sessions.get(tokenHash);
      if (!session) return null;
      const at = now();
      const idle = at.getTime() - Date.parse(session.lastSeenAt);
      if (idle > idleMs) {
        deps.sessions.delete(tokenHash);
        return null;
      }
      const user = deps.users.get(session.userId);
      if (!user || !user.active) {
        deps.sessions.delete(tokenHash);
        return null;
      }
      if (idle > TOUCH_EVERY_MS) deps.sessions.touch(tokenHash, at.toISOString());
      return { user, tokenHash };
    },

    logout(token: string | null): void {
      if (token === null || token === '') return;
      deps.sessions.delete(hashToken(token));
    },

    /** Crea una cuenta. Lanza AuthError si el mail ya existe o la contraseña es corta. */
    async createUser(input: {
      email: string;
      name: string;
      role: UserRole;
      password: string;
      mustChangePassword?: boolean;
    }): Promise<UserRecord> {
      assertPasswordStrength(input.password);
      const email = input.email.trim().toLowerCase();
      if (deps.users.findByEmail(email)) {
        throw new AuthError('EMAIL_TAKEN', 'Ya hay una cuenta con ese mail.', 409);
      }
      const passwordHash = await hash(input.password);
      const user = deps.users.insert({
        id: randomUUID(),
        email,
        name: input.name.trim(),
        role: input.role,
        passwordHash,
        mustChangePassword: input.mustChangePassword ?? false,
        createdAt: now().toISOString(),
      });
      deps.logger.info({ userId: user.id, email: user.email, role: user.role }, 'Cuenta creada');
      return user;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
