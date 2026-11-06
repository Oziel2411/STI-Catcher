import { authOptionsResponseSchema, meResponseSchema } from '@sti-catcher/shared';
import type { AuthOptionsResponse, SessionUser } from '@sti-catcher/shared';
import { z } from 'zod';
import { ApiClientError, apiGet, apiPost } from './client.ts';

/** La cuenta de la sesión actual, o null si no hay sesión (401). */
export async function fetchCurrentUser(signal?: AbortSignal): Promise<SessionUser | null> {
  try {
    return (await apiGet('/api/auth/me', meResponseSchema, signal)).user;
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) return null;
    throw error;
  }
}

export async function login(email: string, password: string): Promise<SessionUser> {
  return (await apiPost('/api/auth/login', meResponseSchema, { email, password })).user;
}

/** Cierra la sesión en el server (la cookie la borra la respuesta). */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: { Accept: 'application/json' } });
  } catch {
    // Sin conexión: igual se vuelve a la pantalla de ingreso.
  }
}

/** Opciones de ingreso (público). Si falla, se asume que no hay recuperación por mail. */
export async function fetchAuthOptions(signal?: AbortSignal): Promise<AuthOptionsResponse> {
  try {
    return await apiGet('/api/auth/options', authOptionsResponseSchema, signal);
  } catch {
    return { passwordReset: false };
  }
}

/** Pide el link para elegir una contraseña nueva. El server responde igual exista o no la cuenta. */
export async function requestPasswordReset(email: string): Promise<void> {
  await apiPost('/api/auth/forgot', z.object({}), { email });
}

/** Elige la contraseña nueva con el token del link (el server responde 204 sin cuerpo). */
export async function resetPassword(token: string, password: string): Promise<void> {
  await apiPost('/api/auth/reset', z.null(), { token, password });
}
