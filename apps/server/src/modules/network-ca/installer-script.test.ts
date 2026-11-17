import { describe, expect, it } from 'vitest';
import {
  InvalidCertificateError,
  buildCaInstallerScript,
  pemBodyLines,
} from './installer-script.ts';

// Forma de un PEM (no hace falta que sea un certificado válido para armar el script).
const pem = [
  '-----BEGIN CERTIFICATE-----',
  'MIIEdTCCAt2gAwIBAgIQZ2xS+abc/def==',
  'AQEFAAOCAY8AMIIBigKCAYEA1Q==',
  '-----END CERTIFICATE-----',
  '',
].join('\r\n');

describe('buildCaInstallerScript', () => {
  it('arma un .cmd con CRLF, solo ASCII y el certificado línea por línea', () => {
    const script = buildCaInstallerScript(pem);

    expect(script).not.toMatch(/(?<!\r)\n/);
    expect(script).toMatch(/^[\x20-\x7e\r\n]*$/);
    expect(script).toContain('  echo -----BEGIN CERTIFICATE-----\r\n');
    expect(script).toContain('  echo MIIEdTCCAt2gAwIBAgIQZ2xS+abc/def==\r\n');
    expect(script).toContain('  echo -----END CERTIFICATE-----\r\n');
    expect(script).toContain('certutil -f -addstore Root "%CRT%"');
    // Pide administrador relanzándose a sí mismo.
    expect(script).toContain('-Verb RunAs');
  });

  it('acepta el PEM con LF y sin salto final', () => {
    expect(pemBodyLines(pem.replaceAll('\r\n', '\n').trim())).toEqual([
      'MIIEdTCCAt2gAwIBAgIQZ2xS+abc/def==',
      'AQEFAAOCAY8AMIIBigKCAYEA1Q==',
    ]);
  });

  it('rechaza lo que no es un PEM o trae caracteres que romperían el .cmd', () => {
    expect(() => buildCaInstallerScript('hola')).toThrow(InvalidCertificateError);
    expect(() => buildCaInstallerScript(pem.replace('AQEF', 'AQ&F'))).toThrow(
      InvalidCertificateError,
    );
    expect(() =>
      buildCaInstallerScript('-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----'),
    ).toThrow(InvalidCertificateError);
  });
});
