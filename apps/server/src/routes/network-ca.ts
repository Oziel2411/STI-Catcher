import { NETWORK_CA_CERT_PATH, NETWORK_CA_INSTALLER_PATH } from '@sti-catcher/shared';
import type { NetworkCaResponse } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../http/validation.ts';
import { buildCaInstallerScript } from '../modules/network-ca/installer-script.ts';

/**
 * Certificado de la red (D-110), sin sesión: la CA es pública (no es la
 * clave) y hace falta antes de poder ingresar sin el aviso del navegador.
 * `readCa` lee el archivo en cada pedido: si se regenera, no hay que reiniciar.
 */
export function registerNetworkCaRoutes(app: FastifyInstance, readCa: () => string | null): void {
  const requireCa = (): string => {
    const pem = readCa();
    if (pem === null) {
      throw new HttpError(
        404,
        'NO_NETWORK_CA',
        'El servidor no tiene el certificado de la red. Avisale a Sistemas.',
      );
    }
    return pem;
  };

  app.get('/api/ca', (): NetworkCaResponse => ({ available: readCa() !== null }));

  app.get(NETWORK_CA_CERT_PATH, (_request, reply) => {
    const pem = requireCa();
    return reply
      .header('content-type', 'application/x-x509-ca-cert')
      .header('content-disposition', 'attachment; filename="sti-catcher-ca.crt"')
      .header('cache-control', 'no-store')
      .send(pem);
  });

  app.get(NETWORK_CA_INSTALLER_PATH, (_request, reply) => {
    const script = buildCaInstallerScript(requireCa());
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', 'attachment; filename="instalar-certificado-sti.cmd"')
      .header('cache-control', 'no-store')
      .send(script);
  });
}
