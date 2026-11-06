import { z } from 'zod';

/**
 * Avisos por mail (D-099, D-104). Los mails van a las cuentas que cada uno
 * elige al pedir un trabajo; acá solo se dice si hay servidor de correo.
 */
export const mailStatusResponseSchema = z.object({
  /** Hay servidor SMTP configurado. */
  configured: z.boolean(),
  /** Remitente (la casilla que manda). null sin SMTP. */
  from: z.string().nullable(),
});
export type MailStatusResponse = z.infer<typeof mailStatusResponseSchema>;

/** El mail de prueba va a quien lo pide. */
export const mailTestResponseSchema = z.object({ sentTo: z.string() });
