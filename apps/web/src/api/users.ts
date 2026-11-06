import { meResponseSchema, userResponseSchema, usersResponseSchema } from '@sti-catcher/shared';
import type {
  CreateUserRequest,
  SessionUser,
  UpdateUserRequest,
  UserSummary,
} from '@sti-catcher/shared';
import { apiGet, apiPatch, apiPost } from './client.ts';

/** Administración de cuentas (solo admins, D-100). */
export const listUsers = async (signal?: AbortSignal): Promise<UserSummary[]> =>
  (await apiGet('/api/users', usersResponseSchema, signal)).users;

export const createUser = async (input: CreateUserRequest): Promise<UserSummary> =>
  (await apiPost('/api/users', userResponseSchema, input)).user;

export const updateUser = async (id: string, patch: UpdateUserRequest): Promise<UserSummary> =>
  (await apiPatch(`/api/users/${encodeURIComponent(id)}`, userResponseSchema, patch)).user;

export const setProvisionalPassword = async (id: string, password: string): Promise<UserSummary> =>
  (
    await apiPost(`/api/users/${encodeURIComponent(id)}/password`, userResponseSchema, {
      password,
    })
  ).user;

/** Mi cuenta. */
export const renameMe = async (name: string): Promise<SessionUser> =>
  (await apiPatch('/api/me', meResponseSchema, { name })).user;

export const changeMyPassword = async (
  currentPassword: string,
  newPassword: string,
): Promise<SessionUser> =>
  (await apiPost('/api/me/password', meResponseSchema, { currentPassword, newPassword })).user;

/**
 * Contraseña provisoria al azar, fácil de dictar: sin letras que se confunden
 * (l, 1, O, 0). 12 caracteres de 56 posibles ≈ 69 bits.
 */
export function generatePassword(length = 12): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('');
}
