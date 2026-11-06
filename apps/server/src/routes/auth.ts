import {
  forgotPasswordRequestSchema,
  loginRequestSchema,
  resetPasswordRequestSchema,
} from '@sti-catcher/shared';
import type { AuthOptionsResponse, MeResponse } from '@sti-catcher/shared';
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
import { PasswordResetError } from '../modules/auth/password-reset.ts';
import type { PasswordReset } from '../modules/auth/password-reset.ts';

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  passwordReset: PasswordReset,
  options: { secure: boolean },
): void {
  const toHttpError = (error: unknown): unknown =>
    error instanceof AuthError || error instanceof PasswordResetError
      ? new HttpError(error.status, error.code, error.message)
      : error;

  app.post('/api/auth/login', async (request, reply): Promise<MeResponse> => {
    const body = parseInput(loginRequestSchema, request.body);
    try {
      // Si ya había una sesión en este navegador, se reemplaza.
      auth.logout(sessionTokenOf(request));
      const { token, user } = await auth.login(body, request.ip);
      reply.header('set-cookie', buildSessionCookie(token, options.secure));
      return { user };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post('/api/auth/logout', (request, reply) => {
    auth.logout(sessionTokenOf(request));
    if (request.user) request.log.info({ userId: request.user.id }, 'Salida');
    return reply.header('set-cookie', buildClearedSessionCookie(options.secure)).status(204).send();
  });

  // La web la usa al cargar y como latido cada 10 minutos (mantiene viva la sesión).
  app.get('/api/auth/me', (request): MeResponse => ({ user: toSessionUser(requireUser(request)) }));

  // Público: la pantalla de ingreso muestra «¿Olvidaste tu contraseña?» solo si anda.
  app.get('/api/auth/options', (): AuthOptionsResponse => ({
    passwordReset: passwordReset.enabled,
  }));

  // Responde igual exista o no la cuenta (no revela qué mails están registrados).
  app.post('/api/auth/forgot', (request, reply) => {
    const { email } = parseInput(forgotPasswordRequestSchema, request.body);
    try {
      passwordReset.requestReset(email, request.ip);
    } catch (error) {
      throw toHttpError(error);
    }
    return reply.status(202).send({});
  });

  app.post('/api/auth/reset', async (request, reply) => {
    const { token, password } = parseInput(resetPasswordRequestSchema, request.body);
    try {
      await passwordReset.resetPassword(token, password, request.ip);
    } catch (error) {
      throw toHttpError(error);
    }
    return reply.status(204).send();
  });
}
