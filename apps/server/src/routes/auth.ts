import { loginRequestSchema } from '@sti-catcher/shared';
import type { MeResponse } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  requireUser,
  sessionTokenOf,
} from '../http/session.ts';
import { HttpError, parseInput } from '../http/validation.ts';
import { AuthError, toSessionUser } from '../modules/auth/auth-service.ts';
import type { AuthService } from '../modules/auth/auth-service.ts';

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  options: { secure: boolean },
): void {
  app.post('/api/auth/login', async (request, reply): Promise<MeResponse> => {
    const body = parseInput(loginRequestSchema, request.body);
    try {
      // Si ya había una sesión en este navegador, se reemplaza.
      auth.logout(sessionTokenOf(request));
      const { token, user } = await auth.login(body, request.ip);
      reply.header('set-cookie', buildSessionCookie(token, options.secure));
      return { user };
    } catch (error) {
      if (error instanceof AuthError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  });

  app.post('/api/auth/logout', (request, reply) => {
    auth.logout(sessionTokenOf(request));
    if (request.user) request.log.info({ userId: request.user.id }, 'Salida');
    return reply.header('set-cookie', buildClearedSessionCookie(options.secure)).status(204).send();
  });

  // La web la usa al cargar y como latido cada 10 minutos (mantiene viva la sesión).
  app.get('/api/auth/me', (request): MeResponse => ({ user: toSessionUser(requireUser(request)) }));
}
