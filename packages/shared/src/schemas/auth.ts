import { z } from 'zod';

/** Rol de una cuenta (D-104): el admin solo administra cuentas. */
export const userRoleSchema = z.enum(['admin', 'user']);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Largo mínimo de una contraseña (D-104). */
export const PASSWORD_MIN_LENGTH = 10;
/** Tope: scrypt procesa todo el texto; nadie necesita más. */
export const PASSWORD_MAX_LENGTH = 200;

/** Mail normalizado: sin espacios y en minúsculas (es el usuario para ingresar). */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Escribí un mail válido.' }).max(254));

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Al ingresar no se valida el largo mínimo: una contraseña corta igual es "incorrecta".
  password: z.string().min(1, 'Escribí la contraseña.').max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** La cuenta con la que se ingresó. Nunca incluye el hash ni el token. */
export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  /** Tiene una contraseña provisoria: hay que cambiarla antes de seguir. */
  mustChangePassword: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const meResponseSchema = z.object({ user: sessionUserSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;
