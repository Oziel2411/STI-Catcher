import { describe, expect, it, vi } from 'vitest';
import { createHostResolver, normalizeIp, shortHostName } from './host-resolver.ts';

describe('shortHostName / normalizeIp', () => {
  it('se queda con el nombre de la PC, en mayúsculas', () => {
    // Formas reales devueltas por dns.lookupService en la red del Centro.
    expect(shortHostName('SISTEMAS2-PC.CAPITANES.local', '192.168.3.115')).toBe('SISTEMAS2-PC');
    expect(shortHostName('OSCOMM6-PC', '192.168.3.31')).toBe('OSCOMM6-PC');
    expect(shortHostName('brn3c2af49c6722', '192.168.3.21')).toBe('BRN3C2AF49C6722');
  });

  it('sin nombre real: null', () => {
    expect(shortHostName('192.168.3.2', '192.168.3.2')).toBeNull();
    expect(shortHostName('192.168.3.2', '::ffff:192.168.3.2')).toBeNull();
    expect(shortHostName('fe80::1', 'fe80::1')).toBeNull();
    expect(shortHostName('  ', '10.0.0.1')).toBeNull();
  });

  it('quita el prefijo IPv4-en-IPv6', () => {
    expect(normalizeIp('::ffff:192.168.3.4')).toBe('192.168.3.4');
    expect(normalizeIp('::1')).toBe('::1');
  });
});

describe('createHostResolver', () => {
  it('cachea aciertos y fallas, y junta pedidos simultáneos', async () => {
    let clock = 0;
    const lookup = vi.fn((ip: string) =>
      ip === '10.0.0.1' ? Promise.resolve('PC-1.dominio.local') : Promise.reject(new Error('x')),
    );
    const resolve = createHostResolver({
      lookup,
      ttlMs: 1000,
      missTtlMs: 100,
      now: () => clock,
    });

    const [a, b] = await Promise.all([resolve('10.0.0.1'), resolve('::ffff:10.0.0.1')]);
    expect([a, b]).toEqual(['PC-1', 'PC-1']);
    expect(lookup).toHaveBeenCalledTimes(1);

    expect(await resolve('10.0.0.2')).toBeNull();
    expect(await resolve('10.0.0.2')).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);

    clock = 200; // venció la falla, no el acierto
    await resolve('10.0.0.1');
    await resolve('10.0.0.2');
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('no espera más que el tiempo límite', async () => {
    const resolve = createHostResolver({
      lookup: () => new Promise(() => undefined),
      timeoutMs: 10,
    });
    expect(await resolve('10.0.0.9')).toBeNull();
  });
});
