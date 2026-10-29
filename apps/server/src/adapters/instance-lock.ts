import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export class InstanceLockError extends Error {
  override name = 'InstanceLockError';
}

export type InstanceLockOptions = {
  lockPath: string;
  selfPid: number;
  /** true si el PID corresponde a otra instancia de STI-Catcher viva. */
  isOtherInstance: (pid: number) => Promise<boolean>;
};

export type InstanceLock = { release(): void };

/**
 * Garantiza una sola instancia por DATA_DIR (D-033).
 *
 * Sin esto, dos instancias con la misma carpeta de datos (p. ej. `npm run dev`
 * y `npm start` a la vez) se pisarían: la recuperación de la segunda mataría
 * los procesos de la primera y marcaría sus jobs como interrumpidos.
 *
 * Archivo con el PID. Si quedó de una ejecución que terminó mal (el proceso ya
 * no existe, o el PID lo reutilizó otro programa), se toma el lock igual.
 */
export async function acquireInstanceLock(options: InstanceLockOptions): Promise<InstanceLock> {
  let previousPid: number | null = null;
  try {
    const content = readFileSync(options.lockPath, 'utf8').trim();
    previousPid = /^\d+$/.test(content) ? Number(content) : null;
  } catch {
    // No existe: no hay otra instancia.
  }

  if (
    previousPid !== null &&
    previousPid !== options.selfPid &&
    (await options.isOtherInstance(previousPid))
  ) {
    throw new InstanceLockError(
      `Ya hay otra instancia de STI-Catcher corriendo (PID ${String(previousPid)}) con la misma carpeta de datos.\n` +
        'Detenela antes de iniciar esta, o configurá otro DATA_DIR.\n' +
        `Si estás seguro de que no hay otra instancia, borrá ${options.lockPath}.`,
    );
  }

  writeFileSync(options.lockPath, String(options.selfPid), 'utf8');

  return {
    release() {
      try {
        if (readFileSync(options.lockPath, 'utf8').trim() === String(options.selfPid)) {
          unlinkSync(options.lockPath);
        }
      } catch {
        // Ya no existe: nada que liberar.
      }
    },
  };
}
