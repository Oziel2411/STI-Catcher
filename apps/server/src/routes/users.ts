import {
  changePasswordRequestSchema,
  createUserRequestSchema,
  setPasswordRequestSchema,
  updateMeRequestSchema,
  updateUserRequestSchema,
  userIdParamsSchema,
} from '@sti-catcher/shared';
import type { MeResponse } from '@sti-catcher/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UserRecord } from '../db/users-repository.ts';
import { requireUser } from '../http/session.ts';
import { HttpError, parseInput } from '../http/validation.ts';
import { AuthError, toSessionUser } from '../modules/auth/auth-service.ts';
import { UsersError } from '../modules/auth/users-service.ts';
import type { Actor, UsersService } from '../modules/auth/users-service.ts';

const actorOf = (request: FastifyRequest): Actor => ({
  user: requireUser(request),
  ip: request.ip,
  tokenHash: request.sessionTokenHash,
});

/** Solo los administradores administran cuentas (D-104). */
function requireAdmin(request: FastifyRequest): Actor {
  const actor = actorOf(request);
  if (actor.user.role !== 'admin') {
    throw new HttpError(403, 'FORBIDDEN', 'Solo un administrador puede administrar las cuentas.');
  }
  return actor;
}

const toHttpError = (error: unknown): unknown =>
  error instanceof UsersError || error instanceof AuthError
    ? new HttpError(error.status, error.code, error.message)
    : error;

async function translate<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toHttpError(error);
  }
}

export function registerUserRoutes(
  app: FastifyInstance,
  users: UsersService,
  getUser: (id: string) => UserRecord | null,
): void {
  /** La cuenta actualizada, como la ve la web en su sesión. */
  const sessionUser = (id: string): MeResponse => {
    const user = getUser(id);
    if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'No existe esa cuenta.');
    return { user: toSessionUser(user) };
  };

  app.get('/api/users', (request) => {
    requireAdmin(request);
    return { users: users.list() };
  });

  app.post('/api/users', async (request, reply) => {
    const actor = requireAdmin(request);
    const body = parseInput(createUserRequestSchema, request.body);
    const user = await translate(() => users.create(body, actor));
    return reply.status(201).send({ user });
  });

  app.patch('/api/users/:id', async (request) => {
    const actor = requireAdmin(request);
    const { id } = parseInput(userIdParamsSchema, request.params);
    const body = parseInput(updateUserRequestSchema, request.body);
    return { user: await translate(() => users.update(id, body, actor)) };
  });

  // Contraseña provisoria: la persona la cambia al ingresar.
  app.post('/api/users/:id/password', async (request) => {
    const actor = requireAdmin(request);
    const { id } = parseInput(userIdParamsSchema, request.params);
    const { password } = parseInput(setPasswordRequestSchema, request.body);
    return { user: await translate(() => users.setProvisionalPassword(id, password, actor)) };
  });

  // Mi cuenta (cualquiera, sobre sí mismo).
  app.patch('/api/me', async (request): Promise<MeResponse> => {
    const actor = actorOf(request);
    const { name } = parseInput(updateMeRequestSchema, request.body);
    await translate(() => users.renameSelf(name, actor));
    return sessionUser(actor.user.id);
  });

  app.post('/api/me/password', async (request): Promise<MeResponse> => {
    const actor = actorOf(request);
    const body = parseInput(changePasswordRequestSchema, request.body);
    await translate(() => users.changeOwnPassword(body, actor));
    return sessionUser(actor.user.id);
  });
}
