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

// --- Procesos largos ------------------------------------------------------------

/**
 * Corta un stream de texto en líneas. Acepta `\n`, `\r\n` y `\r` solo (ffmpeg
 * y yt-dlp usan `\r` para reescribir la línea de progreso). Ignora líneas vacías.
 */
export function createLineSplitter(onLine: (line: string) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      const parts = buffer.split(/\r\n|\r|\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.length > 0) onLine(part);
      }
    },
    flush() {
      if (buffer.length > 0) onLine(buffer);
      buffer = '';
    },
  };
}

export type StreamingOptions = {
  /** Al abortar se mata el árbol de procesos y la promesa se rechaza con `signal.reason`. */
  signal: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Variables de entorno del proceso hijo (por defecto, las del server). */
  env?: NodeJS.ProcessEnv;
  /** Cuántas líneas finales de stderr se guardan para diagnosticar errores. */
  stderrTailLines?: number;
};

export type StreamingResult = {
  exitCode: number | null;
  stderrTail: string[];
};

export type StreamingRunner = (
  file: string,
  args: readonly string[],
  options: StreamingOptions,
) => Promise<StreamingResult>;

/**
 * Ejecuta un proceso largo (descarga, conversión) leyendo su salida línea por línea.
 *
 * La promesa recién se resuelve o rechaza en 'close', es decir cuando el
 * proceso y todos los que heredaron sus pipes terminaron. Así, después de un
 * abort, la cola puede borrar los archivos parciales sabiendo que nadie los
 * tiene abiertos.
 */
export const runStreaming: StreamingRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }

    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });

    const tailSize = options.stderrTailLines ?? 30;
    const stderrTail: string[] = [];
    const stdoutLines = createLineSplitter((line) => options.onStdoutLine?.(line));
    const stderrLines = createLineSplitter((line) => {
      stderrTail.push(line);
      if (stderrTail.length > tailSize) stderrTail.shift();
      options.onStderrLine?.(line);
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutLines.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderrLines.push(chunk);
    });

    const onAbort = () => {
      if (child.pid !== undefined) void killProcessTree(child.pid);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (exitCode) => {
      signal.removeEventListener('abort', onAbort);
      stdoutLines.flush();
      stderrLines.flush();
      if (signal.aborted) {
        reject(signal.reason as Error);
      } else {
        resolve({ exitCode, stderrTail });
      }
    });
  });
