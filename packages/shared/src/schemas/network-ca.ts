import { z } from 'zod';

/**
 * Certificado de la red (D-110): la CA de mkcert que firma el certificado
 * HTTPS del servidor. Se descarga sin sesión desde la página `/certificado`,
 * para instalarla en cada PC sin pasar por el servidor.
 */
export const NETWORK_CA_CERT_PATH = '/api/ca/sti-catcher-ca.crt';
/** Instalador de un clic (`.cmd`) con la CA adentro. */
export const NETWORK_CA_INSTALLER_PATH = '/api/ca/instalar-certificado-sti.cmd';

export const networkCaResponseSchema = z.object({
  /** El servidor tiene la CA (`DATA_DIR\certs\sti-catcher-ca.crt`). */
  available: z.boolean(),
});
export type NetworkCaResponse = z.infer<typeof networkCaResponseSchema>;
