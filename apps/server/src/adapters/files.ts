import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Operaciones de archivos que usa la cola. Todas reciben rutas armadas por el
 * server (STORAGE_DIR + id del job); nunca rutas que vengan del cliente.
 */
export type FileOps = {
  /** Borra todo lo que hay dentro de `dir` (no la carpeta). Devuelve cuántas entradas borró. */
  emptyDir: (dir: string) => Promise<number>;
  /** Borra las entradas de `dir` cuyo nombre empiece con `prefix`. */
  removeByPrefix: (dir: string, prefix: string) => Promise<number>;
  /** Mueve un archivo. Si están en volúmenes distintos, copia y borra. */
  moveFile: (from: string, to: string) => Promise<void>;
  fileSize: (filePath: string) => Promise<number>;
  removeFile: (filePath: string) => Promise<void>;
  ensureDir: (dir: string) => Promise<void>;
};

const removeEntry = (fullPath: string) =>
  // maxRetries: en Windows un antivirus o el indexador pueden tener el archivo abierto un instante.
  rm(fullPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

export const fileOps: FileOps = {
  async emptyDir(dir) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return 0;
    }
    await Promise.all(entries.map((name) => removeEntry(path.join(dir, name))));
    return entries.length;
  },

  async removeByPrefix(dir, prefix) {
    if (prefix.length === 0) throw new Error('removeByPrefix necesita un prefijo no vacío');
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return 0;
    }
    const matching = entries.filter((name) => name.startsWith(prefix));
    await Promise.all(matching.map((name) => removeEntry(path.join(dir, name))));
    return matching.length;
  },

  async moveFile(from, to) {
    try {
      await rename(from, to);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
        await copyFile(from, to);
        await unlink(from);
        return;
      }
      throw error;
    }
  },

  async fileSize(filePath) {
    return (await stat(filePath)).size;
  },

  async removeFile(filePath) {
    await rm(filePath, { force: true, maxRetries: 5, retryDelay: 200 });
  },

  async ensureDir(dir) {
    await mkdir(dir, { recursive: true });
  },
};
