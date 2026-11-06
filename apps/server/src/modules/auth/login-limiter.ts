/**
 * Límite de intentos de ingreso (D-104), en memoria (un solo proceso, D-031):
 * - por cuenta: 5 fallidos seguidos la bloquean 15 minutos. Se cuenta por el
 *   mail escrito, exista o no, para no revelar qué mails tienen cuenta;
 * - por IP: 20 fallidos en 15 minutos bloquean la IP 15 minutos.
 * Un ingreso correcto limpia el contador de esa cuenta (no el de la IP).
 * Reiniciar el server los limpia: es aceptable, solo frena la fuerza bruta.
 */
export type LoginLimiterOptions = {
  maxAccountFailures?: number;
  maxIpFailures?: number;
  windowMs?: number;
  now?: () => number;
};

export type LoginLimiter = {
  /** ms que faltan si está bloqueado; 0 si se puede intentar. */
  blockedFor(email: string, ip: string): number;
  recordFailure(email: string, ip: string): void;
  recordSuccess(email: string): void;
};

export function createLoginLimiter(options: LoginLimiterOptions = {}): LoginLimiter {
  const maxAccount = options.maxAccountFailures ?? 5;
  const maxIp = options.maxIpFailures ?? 20;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const now = options.now ?? Date.now;

  const accounts = new Map<string, { failures: number; lockedUntil: number }>();
  const ips = new Map<string, { failures: number[]; lockedUntil: number }>();

  /** Limpia entradas viejas para que los mapas no crezcan sin límite. */
  const prune = (at: number) => {
    if (accounts.size + ips.size < 1000) return;
    for (const [key, entry] of accounts) {
      if (entry.lockedUntil < at && entry.failures < maxAccount) accounts.delete(key);
    }
    for (const [key, entry] of ips) {
      if (entry.lockedUntil < at && entry.failures.every((t) => t < at - windowMs)) ips.delete(key);
    }
  };

  return {
    blockedFor(email, ip) {
      const at = now();
      const account = accounts.get(email)?.lockedUntil ?? 0;
      const byIp = ips.get(ip)?.lockedUntil ?? 0;
      return Math.max(0, account - at, byIp - at);
    },

    recordFailure(email, ip) {
      const at = now();
      prune(at);
      const account = accounts.get(email) ?? { failures: 0, lockedUntil: 0 };
      account.failures++;
      if (account.failures >= maxAccount) {
        account.lockedUntil = at + windowMs;
        account.failures = 0;
      }
      accounts.set(email, account);

      const byIp = ips.get(ip) ?? { failures: [], lockedUntil: 0 };
      byIp.failures = [...byIp.failures.filter((t) => t > at - windowMs), at];
      if (byIp.failures.length >= maxIp) {
        byIp.lockedUntil = at + windowMs;
        byIp.failures = [];
      }
      ips.set(ip, byIp);
    },

    recordSuccess(email) {
      accounts.delete(email);
    },
  };
}
