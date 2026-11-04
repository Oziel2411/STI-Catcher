import { lookupService } from 'node:dns/promises';

/** IP → nombre que da el sistema (puede venir con dominio: "PC-1.CAPITANES.local"). */
export type HostLookup = (ip: string) => Promise<string>;

/**
 * Nombre de la PC que hizo un pedido, para el filtro "Usuario" del historial
 * (D-098).
 *
 * En la red del Centro no hay DNS inverso: `dns.reverse` da ENOTFOUND. El
 * resolvedor de Windows sí encuentra los nombres por LLMNR/mDNS, y Node lo
 * usa con `dns.lookupService` (getnameinfo). Medido: 5–80 ms si la PC
 * responde; ~4,5 s hasta fallar si no. Por eso hay tiempo límite y caché
 * (también de los que fallan, más corta).
 */
export function createHostResolver(
  options: {
    lookup?: HostLookup;
    timeoutMs?: number;
    ttlMs?: number;
    missTtlMs?: number;
    now?: () => number;
  } = {},
) {
  const lookup = options.lookup ?? (async (ip: string) => (await lookupService(ip, 80)).hostname);
  const timeoutMs = options.timeoutMs ?? 6000;
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
  const missTtlMs = options.missTtlMs ?? 10 * 60 * 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { name: string | null; expires: number }>();
  const pending = new Map<string, Promise<string | null>>();

  const resolve = async (ip: string): Promise<string | null> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((done) => {
      timer = setTimeout(() => {
        done(null);
      }, timeoutMs);
    });
    try {
      const name = await Promise.race([lookup(ip).catch(() => null), timeout]);
      return name === null ? null : shortHostName(name, ip);
    } finally {
      clearTimeout(timer);
    }
  };

  return (rawIp: string): Promise<string | null> => {
    const ip = normalizeIp(rawIp);
    const cached = cache.get(ip);
    if (cached && cached.expires > now()) return Promise.resolve(cached.name);
    const inFlight = pending.get(ip);
    if (inFlight) return inFlight;
    const promise = resolve(ip).then((name) => {
      cache.set(ip, { name, expires: now() + (name === null ? missTtlMs : ttlMs) });
      pending.delete(ip);
      return name;
    });
    pending.set(ip, promise);
    return promise;
  };
}

export type HostResolver = ReturnType<typeof createHostResolver>;

/** "::ffff:192.168.3.4" (IPv4 por un socket IPv6) → "192.168.3.4". */
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
}

/**
 * "sistemas2-pc.CAPITANES.local" → "SISTEMAS2-PC". null si el sistema
 * devolvió la misma IP (no encontró un nombre).
 */
export function shortHostName(hostname: string, ip: string): string | null {
  const name = hostname.trim();
  if (name === '' || name === ip || name === normalizeIp(ip)) return null;
  // Una IP no tiene sentido cortarla por el punto.
  if (/^[\d.]+$/.test(name) || name.includes(':')) return null;
  const first = name.split('.')[0] ?? '';
  return first === '' ? null : first.toUpperCase();
}
