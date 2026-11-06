import { meResponseSchema } from '@sti-catcher/shared';
import type { SessionUser } from '@sti-catcher/shared';
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
