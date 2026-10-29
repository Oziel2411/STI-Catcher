import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { JobsRepository } from '../../jobs/types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type DirEntry = { name: string; modifiedMs: number };

/** Archivos (no carpetas) de `dir` con su fecha de modificación. Carpeta inexistente = vacía. */
export async function listFiles(dir: string): Promise<DirEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const info = await stat(path.join(dir, name));
        return info.isFile() ? { name, modifiedMs: info.mtimeMs } : null;
      } catch {
        return null;
      }
    }),
  );
  return entries.filter((entry): entry is DirEntry => entry !== null);
}

export type RetentionDeps = {
  /** 0 = nunca se borra nada. */
  retentionDays: number;
  repo: Pick<JobsRepository, 'listExpirable' | 'listLiveFilePaths'>;
  /** done → expired y publica el cambio (queue.expire). */
  expire: (jobId: string) => boolean;
  storageDir: string;
  filesDir: string;
  recordingsDir: string;
  listFiles?: (dir: string) => Promise<DirEntry[]>;
  /** Lanza si no pudo (p. ej. archivo abierto). Si no existe, no es error. */
  removeFile?: (file: string) => Promise<void>;
  now?: () => Date;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
};

export type RetentionSummary = { expired: number; orphans: number; recordings: number };

/**
 * Retención automática (SPEC §8): borra los archivos con más de
 * RETENTION_DAYS días. El job queda en el historial como "expirado".
 *
 * También limpia lo que no tiene dueño y quedó viejo: archivos de `files/` que
 * ningún job `done` usa (un borrado que falló a mitad) y crudos de grabación
 * que nunca se procesaron o cuyo procesamiento falló (se conservaban para
 * reintentar). Una grabación en curso recibe un fragmento cada 2 s, así que
 * su crudo nunca es viejo.
 */
export function createRetentionService(deps: RetentionDeps) {
  const list = deps.listFiles ?? listFiles;
  const removeFile =
    deps.removeFile ??
    ((file: string) => rm(file, { force: true, maxRetries: 5, retryDelay: 200 }));
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<RetentionSummary> | null = null;

  const tryRemove = async (file: string) => {
    try {
      await removeFile(file);
      return true;
    } catch (error) {
      deps.logger.warn({ err: error, file }, 'Retención: no se pudo borrar un archivo');
      return false;
    }
  };

  async function sweep(): Promise<RetentionSummary> {
    const summary: RetentionSummary = { expired: 0, orphans: 0, recordings: 0 };
    if (deps.retentionDays === 0) return summary;
    const cutoffMs = now().getTime() - deps.retentionDays * DAY_MS;

    // 1. Archivos de trabajos terminados hace más de N días.
    for (const job of deps.repo.listExpirable(new Date(cutoffMs).toISOString())) {
      // Si no se pudo borrar (abierto por un reproductor), se reintenta en la próxima pasada.
      if (!(await tryRemove(path.resolve(deps.storageDir, job.filePath)))) continue;
      if (deps.expire(job.id)) summary.expired++;
    }

    // 2. Huérfanos viejos en files/.
    const live = new Set(deps.repo.listLiveFilePaths().map((p) => path.basename(p).toLowerCase()));
    for (const entry of await list(deps.filesDir)) {
      if (entry.modifiedMs >= cutoffMs || live.has(entry.name.toLowerCase())) continue;
      if (await tryRemove(path.join(deps.filesDir, entry.name))) summary.orphans++;
    }

    // 3. Crudos de grabación viejos.
    for (const entry of await list(deps.recordingsDir)) {
      if (entry.modifiedMs >= cutoffMs) continue;
      if (await tryRemove(path.join(deps.recordingsDir, entry.name))) summary.recordings++;
    }

    if (summary.expired + summary.orphans + summary.recordings > 0) {
      deps.logger.info({ ...summary, retentionDays: deps.retentionDays }, 'Retención aplicada');
    }
    return summary;
  }

  /** Una pasada a la vez: si ya hay una en curso, devuelve esa. */
  const run = (): Promise<RetentionSummary> => {
    running ??= sweep().finally(() => {
      running = null;
    });
    return running;
  };

  const runLogged = () => {
    run().catch((error: unknown) => {
      deps.logger.warn({ err: error }, 'Retención: error en la pasada');
    });
  };

  return {
    run,
    /** Una pasada al arrancar y después cada hora. */
    start() {
      if (deps.retentionDays === 0 || timer !== null) return;
      runLogged();
      timer = setInterval(runLogged, SWEEP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

export type RetentionService = ReturnType<typeof createRetentionService>;
