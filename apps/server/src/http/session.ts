import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UserRecord } from '../db/users-repository.ts';
import type { AuthService } from '../modules/auth/auth-service.ts';
import { HttpError } from './validation.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** La cuenta de la sesión (D-100). null solo en las rutas públicas. */
    user: UserRecord | null;
    /** SHA-256 del token de la sesión actual. */
    sessionTokenHash: string | null;
  }
}

export const SESSION_COOKIE = 'sti_session';

/** Rutas de la API que se pueden usar sin sesión. */
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/health']);
/**
 * Con una contraseña provisoria solo se puede cambiarla (D-100): el resto de
 * la API responde 403 `PASSWORD_CHANGE_REQUIRED` hasta que se cambie.
 */
const ALLOWED_WITH_PROVISIONAL_PASSWORD = new Set([
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/login',
  '/api/me/password',
  '/api/health',
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Lee una cookie del header Cookie. null si no está. */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * Cookie de sesión (D-100):
 * - sin Max-Age: dura hasta cerrar el navegador (el server además corta a las 12 h sin uso);
 * - HttpOnly: JavaScript no la lee;
 * - SameSite=Lax: no viaja en pedidos POST que otro sitio dispare contra la app;
 * - Secure con HTTPS (en desarrollo, por HTTP en localhost, el navegador no la mandaría).
 */
export function buildSessionCookie(token: string, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearedSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const sessionTokenOf = (request: FastifyRequest): string | null =>
  readCookie(request.headers.cookie, SESSION_COOKIE);

/** La cuenta del pedido. Lanza 401 si no hay sesión (no debería pasar: lo frena el hook). */
export function requireUser(request: FastifyRequest): UserRecord {
  if (request.user === null) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Tenés que ingresar para usar STI-Catcher.');
  }
  return request.user;
}

export type SessionOptions = {
  auth: AuthService;
  /** Orígenes aceptados además del propio (en desarrollo, el de Vite). */
  extraOrigins?: readonly string[];
};

/**
 * Login obligatorio (D-100): toda la API, salvo `PUBLIC_API`, responde 401
 * sin una sesión válida. La web (index.html y sus archivos) es pública: la
 * pantalla de ingreso tiene que poder cargarse.
 *
 * Los pedidos que cambian algo tienen que venir de la propia app: si traen
 * `Origin`, tiene que ser el del server (refuerzo contra CSRF además de SameSite).
 */
export function registerSession(app: FastifyInstance, options: SessionOptions): void {
  const extraOrigins = new Set(options.extraOrigins ?? []);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionTokenHash', null);

  app.addHook('onRequest', (request, _reply, done) => {
    try {
      checkRequest(request);
      done();
    } catch (error) {
      done(error as Error);
    }
  });

  function checkRequest(request: FastifyRequest): void {
    const path = request.url.split('?', 1)[0] ?? '';
    const isApi = path === '/api' || path.startsWith('/api/');
    if (!isApi) return;

    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (origin !== undefined && !extraOrigins.has(origin)) {
        let host: string | null;
        try {
          host = new URL(origin).host;
        } catch {
          host = null;
        }
        if (host !== request.host) {
          throw new HttpError(403, 'BAD_ORIGIN', 'El pedido no viene de STI-Catcher.');
        }
      }
    }

    const session = options.auth.authenticate(sessionTokenOf(request));
    request.user = session?.user ?? null;
    request.sessionTokenHash = session?.tokenHash ?? null;
    if (session === null && !PUBLIC_API.has(path)) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Tenés que ingresar para usar STI-Catcher.');
    }
    if (session?.user.mustChangePassword === true && !ALLOWED_WITH_PROVISIONAL_PASSWORD.has(path)) {
      throw new HttpError(
        403,
        'PASSWORD_CHANGE_REQUIRED',
        'Tu contraseña es provisoria: cambiala para seguir.',
      );
    }
  }
}
