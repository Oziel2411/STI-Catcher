import { z } from 'zod';

/**
 * Aviso por mail al terminar una grabación (D-099). Las direcciones de los
 * destinatarios no se exponen: solo cuántos son.
 */
export const mailStatusResponseSchema = z.object({
  /** Hay servidor SMTP configurado. */
  configured: z.boolean(),
  /** Remitente (la casilla que manda). null sin SMTP. */
  from: z.string().nullable(),
  recipients: z.number().int().nonnegative(),
});
export type MailStatusResponse = z.infer<typeof mailStatusResponseSchema>;

export const mailTestResponseSchema = z.object({ sentTo: z.number().int().positive() });
