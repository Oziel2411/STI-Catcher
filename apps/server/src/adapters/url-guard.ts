import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Rangos que no son internet público: red local, loopback, link-local,
 * CGNAT, multicast, reservados. Fuente: IANA special-purpose registries.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** true si la IP es de la red interna (o no es pública). */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blocked.check(address, 'ipv4');
  if (version === 6) {
    // IPv4 escrita como IPv6 (::ffff:10.0.0.1): se evalúa la IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true; // no es una IP: por las dudas, bloqueada
}

export class UrlBlockedError extends Error {
  override name = 'UrlBlockedError';
  constructor() {
    super('El link apunta a la red interna o a este mismo servidor: no está permitido.');
  }
}

export class UrlResolveError extends Error {
  override name = 'UrlResolveError';
  constructor(host: string) {
    super(`No se encontró el sitio "${host}". Revisá el link.`);
  }
}

export type HostLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: HostLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, order: 'verbatim' })).map((entry) => entry.address);

export type UrlGuard = (url: string) => Promise<void>;

/**
 * Segunda capa contra SSRF (D-040): rechaza URLs cuyo host sea o resuelva a
 * una IP de la red interna. La primera capa es no usar el extractor `generic`.
 *
 * Limitación conocida: yt-dlp sigue redirecciones por su cuenta, y un DNS
 * podría devolver otra IP en el momento de la descarga. No es un bloqueo total.
 */
export function createUrlGuard(options: { enabled: boolean; lookup?: HostLookup }): UrlGuard {
  const lookup = options.lookup ?? defaultLookup;
  return async (url) => {
    if (!options.enabled) return;
    // La URL ya viene validada como http/https por el esquema de shared.
    const { hostname } = new URL(url);
    const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) throw new UrlBlockedError();

    let addresses: string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = await lookup(host);
      } catch {
        throw new UrlResolveError(host);
      }
    }
    // Si alguna de las IPs es interna se rechaza: el cliente HTTP podría usar cualquiera.
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new UrlBlockedError();
  };
}
