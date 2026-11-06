import { describe, expect, it } from 'vitest';
import { DEFAULT_SCRYPT_PARAMS, hashPassword, verifyPassword } from './password.ts';

// Parámetros chicos para que los tests sean rápidos. Con los de producción
// (N = 2^15, 32 MB) un solo hash dentro de un hilo de Vitest frenaba ~6 s a
// los tests de otros archivos que comparten los hilos de libuv.
const fast = { log2N: 10, r: 8, p: 1 };

describe('hashPassword / verifyPassword', () => {
  it('parámetros por defecto: N = 2^15, r = 8, p = 1 (D-100)', () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ log2N: 15, r: 8, p: 1 });
  });

  it('formato scrypt$<log2 N>$r$p$sal$hash, y verifica con los parámetros guardados', async () => {
    const stored = await hashPassword('una contraseña larga', fast);
    expect(stored).toMatch(/^scrypt\$10\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
    expect(await verifyPassword('una contraseña larga', stored)).toBe(true);
  });

  it('rechaza otra contraseña; la misma da otro hash (sal al azar)', async () => {
    const a = await hashPassword('contraseña-1', fast);
    const b = await hashPassword('contraseña-1', fast);
    expect(a).not.toBe(b);
    expect(await verifyPassword('contraseña-1', b)).toBe(true);
    expect(await verifyPassword('contraseña-2', a)).toBe(false);
    expect(await verifyPassword('Contraseña-1', a)).toBe(false);
  });

  it('normaliza a NFC: la ñ compuesta y la descompuesta valen igual', async () => {
    const stored = await hashPassword('mañana-temprano', fast);
    expect(await verifyPassword('mañana-temprano', stored)).toBe(true);
  });

  it('un hash con formato raro da false, sin lanzar', async () => {
    for (const stored of [
      '',
      'texto plano',
      'bcrypt$10$abc',
      'scrypt$x$8$1$c2Fs$aGFzaA==',
      'scrypt$30$8$1$c2Fs$aGFzaA==',
      'scrypt$10$8$1$$aGFzaA==',
      'scrypt$10$8$1$c2Fs$corto',
    ]) {
      expect(await verifyPassword('lo-que-sea', stored)).toBe(false);
    }
  });
});
