import { rmSync } from 'node:fs';
import {
  NETWORK_CA_CERT_PATH,
  NETWORK_CA_INSTALLER_PATH,
  apiErrorSchema,
  networkCaResponseSchema,
} from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test/test-app.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app(options: Parameters<typeof makeTestApp>[0] = {}) {
  const testApp = await makeTestApp(options);
  storageDirs.push(testApp.storageDir);
  return testApp;
}

const pem = '-----BEGIN CERTIFICATE-----\nMIIEdTCCAt2gAwIBAgIQ\n-----END CERTIFICATE-----\n';
/** Sin la sesión por defecto de la app de prueba: es para antes de ingresar. */
const anonymous = { cookie: '' };

describe('certificado de la red (D-110)', () => {
  it('se descarga sin sesión: la CA y el instalador', async () => {
    const testApp = await app({ networkCaPem: pem });

    const status = await testApp.app.inject({ url: '/api/ca', headers: anonymous });
    expect(networkCaResponseSchema.parse(status.json())).toEqual({ available: true });

    const cert = await testApp.app.inject({ url: NETWORK_CA_CERT_PATH, headers: anonymous });
    expect(cert.statusCode).toBe(200);
    expect(cert.headers['content-type']).toBe('application/x-x509-ca-cert');
    expect(cert.headers['content-disposition']).toBe('attachment; filename="sti-catcher-ca.crt"');
    expect(cert.body).toBe(pem);

    const installer = await testApp.app.inject({
      url: NETWORK_CA_INSTALLER_PATH,
      headers: anonymous,
    });
    expect(installer.statusCode).toBe(200);
    expect(installer.headers['content-disposition']).toBe(
      'attachment; filename="instalar-certificado-sti.cmd"',
    );
    expect(installer.body).toContain('  echo MIIEdTCCAt2gAwIBAgIQ\r\n');
  });

  it('sin la CA en el servidor: available false y 404 con un mensaje', async () => {
    const testApp = await app();

    const status = await testApp.app.inject({ url: '/api/ca', headers: anonymous });
    expect(networkCaResponseSchema.parse(status.json())).toEqual({ available: false });

    for (const url of [NETWORK_CA_CERT_PATH, NETWORK_CA_INSTALLER_PATH]) {
      const response = await testApp.app.inject({ url, headers: anonymous });
      expect(response.statusCode, url).toBe(404);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('NO_NETWORK_CA');
    }
  });
});
