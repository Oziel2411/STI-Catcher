import { statfs } from 'node:fs/promises';

export type DiskSpace = { freeBytes: number; totalBytes: number };

export type DiskSpaceReader = (dir: string) => Promise<DiskSpace>;

/**
 * Espacio del volumen donde está `dir`. Usa `fs.statfs` (incluido en Node),
 * sin dependencias ni comandos externos.
 * `bavail` = bloques disponibles para usuarios sin privilegios (lo que importa acá).
 */
export const readDiskSpace: DiskSpaceReader = async (dir) => {
  const stats = await statfs(dir);
  return {
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
  };
};
