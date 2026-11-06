import { z } from 'zod';
import { emailSchema, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, userRoleSchema } from './auth.ts';

/** Nombre de una cuenta: es lo que se ve en el historial. */
export const userNameSchema = z
  .string()
  .trim()
  .min(1, 'Escribí un nombre.')
  .max(80, 'El nombre puede tener hasta 80 caracteres.');

/** Contraseña nueva (al crear, poner una provisoria o cambiarla). */
export const newPasswordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `La contraseña tiene que tener al menos ${String(PASSWORD_MIN_LENGTH)} caracteres.`,
  )
  .max(
    PASSWORD_MAX_LENGTH,
    `La contraseña puede tener hasta ${String(PASSWORD_MAX_LENGTH)} caracteres.`,
  );

/** Una cuenta vista por un administrador (D-104). Nunca incluye el hash. */
export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  active: z.boolean(),
  mustChangePassword: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const usersResponseSchema = z.object({ users: z.array(userSummarySchema) });
export const userResponseSchema = z.object({ user: userSummarySchema });

/** El admin crea la cuenta con una contraseña provisoria: hay que cambiarla al entrar. */
export const createUserRequestSchema = z.object({
  email: emailSchema,
  name: userNameSchema,
  role: userRoleSchema.default('user'),
  password: newPasswordSchema,
});
export type CreateUserRequest = z.input<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    name: userNameSchema.optional(),
    role: userRoleSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'No hay nada para cambiar.');
export type UpdateUserRequest = z.input<typeof updateUserRequestSchema>;

/** Contraseña provisoria que pone un admin. */
export const setPasswordRequestSchema = z.object({ password: newPasswordSchema });
export type SetPasswordRequest = z.input<typeof setPasswordRequestSchema>;

export const userIdParamsSchema = z.object({ id: z.uuid('No es un id válido.') });

/** Mi cuenta: cambiar el nombre. */
export const updateMeRequestSchema = z.object({ name: userNameSchema });
export type UpdateMeRequest = z.input<typeof updateMeRequestSchema>;

/** Mi cuenta: cambiar la contraseña (pide la actual). */
export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, 'Escribí tu contraseña actual.').max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.input<typeof changePasswordRequestSchema>;

/** Qué opciones de ingreso hay (público: lo pide la pantalla de ingreso). */
export const authOptionsResponseSchema = z.object({
  /** Se puede recuperar la contraseña por mail (hay SMTP y PUBLIC_URL). */
  passwordReset: z.boolean(),
});
export type AuthOptionsResponse = z.infer<typeof authOptionsResponseSchema>;

/** «¿Olvidaste tu contraseña?»: manda un link al mail, si tiene cuenta. */
export const forgotPasswordRequestSchema = z.object({ email: emailSchema });
export type ForgotPasswordRequest = z.input<typeof forgotPasswordRequestSchema>;

/** Elegir una contraseña nueva con el token del link. */
export const resetPasswordRequestSchema = z.object({
  token: z.string().min(20).max(200),
  password: newPasswordSchema,
});
export type ResetPasswordRequest = z.input<typeof resetPasswordRequestSchema>;

/**
 * A quién avisar por mail cuando termina o falla un trabajo (D-104): ids de
 * cuentas (la propia incluida si quiere el aviso). Sin repetidos.
 */
export const notifyUserIdsSchema = z
  .array(z.uuid())
  .max(30, 'Se puede avisar a hasta 30 personas.')
  .transform((ids) => [...new Set(ids)])
  .default([]);

/** Cuentas a las que se puede avisar (sin mails: solo id y nombre). */
export const userDirectoryResponseSchema = z.object({
  users: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type UserDirectoryResponse = z.infer<typeof userDirectoryResponseSchema>;
