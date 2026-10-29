import { spawn } from 'node:child_process';

/**
 * Ejecución de procesos externos.
 *
 * Reglas (SPEC §10):
 * - siempre `spawn` con array de argumentos y `shell: false`;
 * - para cortar un proceso se mata el árbol completo con `taskkill /T /F`:
 *   `process.kill()` en Windows no mata a los hijos, y tanto `yt-dlp.exe`
 *   (empaquetado con PyInstaller) como el propio yt-dlp lanzan subprocesos.
 */

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type RunCommandOptions = {
  timeoutMs: number;
  /** Máximo de caracteres que se guardan de cada salida (el resto se descarta). */
  maxOutputChars?: number;
};

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: RunCommandOptions,
) => Promise<CommandResult>;

/** Argumentos de taskkill para matar un proceso y todos sus hijos. */
export function buildTaskkillArgs(pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new RangeError(`PID inválido: ${pid}`);
  }
  return ['/PID', String(pid), '/T', '/F'];
}

/** Mata el árbol de procesos. Resuelve siempre: si el proceso ya no existe, no es un error. */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', buildTaskkillArgs(pid), {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => {
      resolve();
    });
    killer.once('close', () => {
      resolve();
    });
  });
}

const appendCapped = (current: string, chunk: string, max: number) =>
  current.length >= max ? current : (current + chunk).slice(0, max);

/** Ejecuta un comando corto (p. ej. `--version`) y junta su salida. */
export const runCommand: CommandRunner = (file, args, { timeoutMs, maxOutputChars = 64_000 }) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk, maxOutputChars);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk, maxOutputChars);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void killProcessTree(child.pid);
    }, timeoutMs);

    // 'error' se emite si el ejecutable no existe (ENOENT) o no se puede lanzar.
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
