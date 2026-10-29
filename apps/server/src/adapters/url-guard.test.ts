import { describe, expect, it } from 'vitest';
import { createUrlGuard, isPrivateAddress, UrlBlockedError, UrlResolveError } from './url-guard.ts';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.10',
    '169.254.169.254', // metadata de nubes
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd12:3456::1',
    '::ffff:192.168.1.1',
    'no-es-ip',
  ])('%s es interna', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '142.250.79.46', '172.32.0.1', '2800:3f0:4002:80b::200e', '::ffff:8.8.8.8'])(
    '%s es pública',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('createUrlGuard', () => {
  const guard = (resolved: Record<string, string[]>) =>
    createUrlGuard({
      enabled: true,
      lookup: (host) => {
        const result = resolved[host];
        return result ? Promise.resolve(result) : Promise.reject(new Error('ENOTFOUND'));
      },
    });

  it('deja pasar sitios públicos', async () => {
    await expect(
      guard({ 'www.youtube.com': ['142.250.79.46'] })('https://www.youtube.com/watch?v=x'),
    ).resolves.toBeUndefined();
  });

  it.each([
    'http://localhost:3000/api/health',
    'http://app.localhost/',
    'http://127.0.0.1/',
    'http://[::1]:8080/',
    'http://192.168.1.20/video.mp4',
  ])('bloquea %s', async (url) => {
    await expect(guard({})(url)).rejects.toBeInstanceOf(UrlBlockedError);
  });

  it('bloquea un nombre que resuelve a una IP interna (p. ej. intranet)', async () => {
    await expect(
      guard({ 'intranet.empresa.local': ['10.0.0.8'] })('http://intranet.empresa.local/'),
    ).rejects.toBeInstanceOf(UrlBlockedError);
  });

  it('bloquea si alguna de las IPs resueltas es interna', async () => {
    await expect(
      guard({ 'mixto.example': ['8.8.8.8', '10.0.0.1'] })('https://mixto.example/'),
    ).rejects.toBeInstanceOf(UrlBlockedError);
  });

  it('host inexistente: error claro', async () => {
    await expect(guard({})('https://no-existe.example/')).rejects.toBeInstanceOf(UrlResolveError);
  });

  it('deshabilitado no consulta nada', async () => {
    const off = createUrlGuard({
      enabled: false,
      lookup: () => Promise.reject(new Error('no debería llamarse')),
    });
    await expect(off('http://127.0.0.1/')).resolves.toBeUndefined();
  });
});
