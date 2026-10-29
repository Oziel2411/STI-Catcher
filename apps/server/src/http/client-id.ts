import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Id anónimo del navegador (cookie). Sirve para "Mis trabajos"; no es autenticación. */
    clientId: string;
  }
}

export const CLIENT_COOKIE = 'sti_client';
/** Chrome no acepta cookies de más de 400 días. Se renueva en cada request. */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Lee el clientId del header Cookie. null si no está o no es un UUID válido. */
export function readClientId(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== CLIENT_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return UUID.test(value) ? value.toLowerCase() : null;
  }
  return null;
}

/**
 * Cookie del clientId (D-041):
 * - HttpOnly: JavaScript no la lee; la UI recibe `isMine` ya calculado.
 * - SameSite=Lax: no viaja en pedidos que otro sitio dispare contra la app.
 * - Secure solo con HTTPS (en desarrollo, por HTTP en localhost, no se mandaría).
 */
export function buildClientCookie(clientId: string, secure: boolean): string {
  const parts = [
    `${CLIENT_COOKIE}=${clientId}`,
    'Path=/',
    `Max-Age=${String(MAX_AGE_SECONDS)}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Asigna `request.clientId` en cada request; si el navegador no tiene cookie, le crea una. */
export function registerClientId(app: FastifyInstance, options: { secure: boolean }): void {
  app.decorateRequest('clientId', '');
  app.addHook('onRequest', async (request, reply) => {
    const clientId = readClientId(request.headers.cookie) ?? randomUUID();
    request.clientId = clientId;
    // Se manda siempre para renovar el vencimiento.
    reply.header('set-cookie', buildClientCookie(clientId, options.secure));
  });
}
