import type { FileOps } from '../adapters/files.ts';
import { selectOrphanProcesses } from '../adapters/process-list.ts';
import type { ProcessInfo, ProcessLister } from '../adapters/process-list.ts';
import { INTERRUPTED_MESSAGE } from './errors.ts';
import type { QueueLogger } from './queue.ts';
import type { JobsRepository } from './types.ts';

export type RecoveryDeps = {
  repo: Pick<JobsRepository, 'failAllRunning'>;
  listProcesses: ProcessLister;
  killProcessTree: (pid: number) => Promise<void>;
  files: Pick<FileOps, 'emptyDir'>;
  binDir: string;
  tempDir: string;
  selfPid: number;
  now: () => Date;
  logger: QueueLogger;
};

export type RecoveryReport = {
  killedProcesses: ProcessInfo[];
  removedTempEntries: number;
  interruptedJobIds: string[];
};

/**
 * Deja el sistema en un estado limpio al arrancar, antes de aceptar requests
 * (D-031). El orden importa:
 *
 * 1. Matar procesos huérfanos (yt-dlp/ffmpeg de una ejecución anterior que
 *    terminó mal): pueden tener abiertos archivos de la carpeta temporal.
 * 2. Vaciar la carpeta temporal: son parciales de jobs que no terminaron.
 * 3. Marcar como failed los jobs que estaban running.
 *
 * Los jobs queued quedan como están; `queue.start()` los retoma en orden.
 * Si no se pueden listar los procesos, se sigue igual: no debe impedir arrancar.
 */
export async function recoverOnStartup(deps: RecoveryDeps): Promise<RecoveryReport> {
  let killedProcesses: ProcessInfo[] = [];
  try {
    const orphans = selectOrphanProcesses(await deps.listProcesses(), deps.binDir, deps.selfPid);
    for (const orphan of orphans) {
      await deps.killProcessTree(orphan.pid);
    }
    killedProcesses = orphans;
    if (orphans.length > 0) {
      deps.logger.warn({ processes: orphans }, 'Procesos huérfanos terminados');
    }
  } catch (error) {
    deps.logger.warn({ err: error }, 'No se pudo verificar si hay procesos huérfanos');
  }

  const removedTempEntries = await deps.files.emptyDir(deps.tempDir);
  const interruptedJobIds = deps.repo.failAllRunning(INTERRUPTED_MESSAGE, deps.now().toISOString());

  if (removedTempEntries > 0 || interruptedJobIds.length > 0) {
    deps.logger.info(
      { removedTempEntries, interruptedJobIds },
      'Recuperación después de un reinicio',
    );
  }
  return { killedProcesses, removedTempEntries, interruptedJobIds };
}
