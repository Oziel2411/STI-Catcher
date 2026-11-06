import type {
  ChangePasswordRequest,
  CreateUserRequest,
  UpdateUserRequest,
  UserRole,
  UserSummary,
} from '@sti-catcher/shared';
import type { SessionsRepository } from '../../db/sessions-repository.ts';
import type { UserPatch, UserRecord, UsersRepository } from '../../db/users-repository.ts';
import type { AuthService } from './auth-service.ts';
import type { LoginLimiter } from './login-limiter.ts';
import { hashPassword, verifyPassword } from './password.ts';

/** Error con mensaje para el usuario; las rutas lo traducen al código HTTP. */
export class UsersError extends Error {
  override name = 'UsersError';
  constructor(
    readonly code:
      | 'USER_NOT_FOUND'
      | 'SELF_CHANGE'
      | 'LAST_ADMIN'
      | 'WRONG_PASSWORD'
      | 'SAME_PASSWORD'
      | 'TOO_MANY_ATTEMPTS',
    message: string,
    readonly status: 400 | 404 | 409 | 429,
  ) {
    super(message);
  }
}

export type UsersServiceDeps = {
  users: UsersRepository;
  sessions: SessionsRepository;
  auth: Pick<AuthService, 'createUser'>;
  /** Para frenar a quien prueba contraseñas desde «Mi cuenta». */
  limiter: LoginLimiter;
  logger: { info: (obj: object, msg: string) => void };
  now?: () => Date;
  hash?: (password: string) => Promise<string>;
  verify?: (password: string, stored: string) => Promise<boolean>;
};

/** Quién pide el cambio (para el log y las reglas sobre uno mismo). */
export type Actor = { user: UserRecord; ip: string | null; tokenHash: string | null };

export const toUserSummary = (user: UserRecord): UserSummary => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  active: user.active,
  mustChangePassword: user.mustChangePassword,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
});

/**
 * Administración de cuentas (solo admins, D-100) y «Mi cuenta» (cada uno).
 * El admin no tiene otros poderes: esto es todo lo que lo distingue.
 */
export function createUsersService(deps: UsersServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const hash = deps.hash ?? ((password: string) => hashPassword(password));
  const verify = deps.verify ?? verifyPassword;

  const getOrThrow = (id: string): UserRecord => {
    const user = deps.users.get(id);
    if (!user) throw new UsersError('USER_NOT_FOUND', 'No existe esa cuenta.', 404);
    return user;
  };

  /** ¿Este cambio deja al sistema sin ningún administrador activo? */
  const removesLastAdmin = (target: UserRecord, role: UserRole, active: boolean) =>
    target.role === 'admin' &&
    target.active &&
    (role !== 'admin' || !active) &&
    deps.users.countAdmins() <= 1;

  return {
    list(): UserSummary[] {
      return deps.users.list().map(toUserSummary);
    },

    /** Crea una cuenta con contraseña provisoria: se cambia al primer ingreso. */
    async create(input: CreateUserRequest, actor: Actor): Promise<UserSummary> {
      const user = await deps.auth.createUser({
        email: input.email,
        name: input.name,
        role: input.role ?? 'user',
        password: input.password,
        mustChangePassword: true,
      });
      deps.logger.info(
        { userId: user.id, email: user.email, role: user.role, by: actor.user.id, ip: actor.ip },
        'Cuenta creada por un administrador',
      );
      return toUserSummary(user);
    },

    update(id: string, patch: UpdateUserRequest, actor: Actor): UserSummary {
      const target = getOrThrow(id);
      const role = patch.role ?? target.role;
      const active = patch.active ?? target.active;
      if (target.id === actor.user.id && (role !== target.role || !active)) {
        throw new UsersError(
          'SELF_CHANGE',
          'No podés quitarte el rol de administrador ni desactivar tu propia cuenta.',
          409,
        );
      }
      if (removesLastAdmin(target, role, active)) {
        throw new UsersError(
          'LAST_ADMIN',
          'Tiene que quedar al menos un administrador activo.',
          409,
        );
      }
      const changes: UserPatch = {};
      if (patch.name !== undefined && patch.name !== target.name) changes.name = patch.name;
      if (role !== target.role) changes.role = role;
      if (active !== target.active) changes.active = active;
      if (Object.keys(changes).length > 0) {
        deps.users.update(id, changes, now().toISOString());
        // Una cuenta desactivada no puede seguir usando la app.
        if (changes.active === false) deps.sessions.deleteForUser(id);
        deps.logger.info(
          { userId: id, changes, by: actor.user.id, ip: actor.ip },
          'Cuenta modificada',
        );
      }
      return toUserSummary(getOrThrow(id));
    },

    /** Contraseña provisoria puesta por un admin: corta las sesiones de esa cuenta. */
    async setProvisionalPassword(id: string, password: string, actor: Actor): Promise<UserSummary> {
      getOrThrow(id);
      deps.users.setPassword(id, await hash(password), true, now().toISOString());
      deps.sessions.deleteForUser(id);
      deps.logger.info(
        { userId: id, by: actor.user.id, ip: actor.ip },
        'Contraseña provisoria puesta por un administrador',
      );
      return toUserSummary(getOrThrow(id));
    },

    renameSelf(name: string, actor: Actor): UserSummary {
      deps.users.update(actor.user.id, { name }, now().toISOString());
      return toUserSummary(getOrThrow(actor.user.id));
    },

    /**
     * Cambia la propia contraseña (pide la actual). Quita la marca de
     * provisoria y corta las demás sesiones de la cuenta; la actual sigue.
     */
    async changeOwnPassword(input: ChangePasswordRequest, actor: Actor): Promise<UserSummary> {
      const key = actor.user.email;
      const ip = actor.ip ?? 'desconocida';
      if (deps.limiter.blockedFor(key, ip) > 0) {
        throw new UsersError(
          'TOO_MANY_ATTEMPTS',
          'Demasiados intentos fallidos. Probá de nuevo en unos minutos.',
          429,
        );
      }
      if (!(await verify(input.currentPassword, actor.user.passwordHash))) {
        deps.limiter.recordFailure(key, ip);
        throw new UsersError('WRONG_PASSWORD', 'La contraseña actual no es correcta.', 400);
      }
      if (input.newPassword === input.currentPassword) {
        throw new UsersError(
          'SAME_PASSWORD',
          'La contraseña nueva tiene que ser distinta de la actual.',
          400,
        );
      }
      deps.users.setPassword(
        actor.user.id,
        await hash(input.newPassword),
        false,
        now().toISOString(),
      );
      if (actor.tokenHash !== null) {
        deps.sessions.deleteForUserExcept(actor.user.id, actor.tokenHash);
      } else {
        deps.sessions.deleteForUser(actor.user.id);
      }
      deps.logger.info({ userId: actor.user.id, ip: actor.ip }, 'Contraseña cambiada');
      return toUserSummary(getOrThrow(actor.user.id));
    },
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
