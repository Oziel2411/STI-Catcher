import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Hash de contraseñas con scrypt (D-100), de `node:crypto`: sin módulos
 * nativos (argon2 necesitaría compilar y los scripts de npm están bloqueados, D-004).
 *
 * Formato guardado: `scrypt$<log2 N>$<r>$<p>$<sal base64>$<hash base64>`.
 * Los parámetros van en el texto para poder subirlos más adelante sin
 * invalidar las contraseñas existentes.
 */
export type ScryptParams = { log2N: number; r: number; p: number };

/** N = 2^15, r = 8, p = 1: ~32 MB y ~50-100 ms por intento en una PC de oficina. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { log2N: 15, r: 8, p: 1 };

const SALT_BYTES = 16;
const KEY_BYTES = 32;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.log2N;
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFC'),
      salt,
      KEY_BYTES,
      // maxmem: el default (32 MB) queda justo para N = 2^15 (128 · N · r = 32 MB).
      { N, r: params.r, p: params.p, maxmem: 256 * N * params.r },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return [
    'scrypt',
    String(params.log2N),
    String(params.r),
    String(params.p),
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/** true si la contraseña corresponde al hash. Un hash con formato raro da false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [log2N, r, p] = parts.slice(1, 4).map(Number);
  if (
    log2N === undefined ||
    r === undefined ||
    p === undefined ||
    ![log2N, r, p].every((n) => Number.isInteger(n) && n > 0) ||
    log2N > 20
  ) {
    return false;
  }
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
  const actual = await derive(password, salt, { log2N, r, p });
  return timingSafeEqual(actual, expected);
}
