import path from 'node:path';
import { z } from 'zod';
import type { CommandRunner } from './process.ts';

export type ProcessInfo = { pid: number; executablePath: string };

export type ProcessLister = () => Promise<ProcessInfo[]>;

/**
 * Comando fijo (sin datos de usuario) que lista los procesos con su ejecutable.
 * Se usa PowerShell + CIM porque `wmic` ya no viene en Windows actuales.
 */
const LIST_COMMAND =
  'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ' +
  'Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress';

const cimProcessSchema = z.object({
  ProcessId: z.number().int().positive(),
  ExecutablePath: z.string().min(1),
});

/** Parsea la salida de ConvertTo-Json (un objeto si hay uno solo, un array si hay varios). */
export function parseProcessList(json: string): ProcessInfo[] {
  const trimmed = json.trim();
  if (trimmed === '') return [];
  const parsed: unknown = JSON.parse(trimmed);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    const result = cimProcessSchema.safeParse(item);
    return result.success
      ? [{ pid: result.data.ProcessId, executablePath: result.data.ExecutablePath }]
      : [];
  });
}

export function createProcessLister(run: CommandRunner): ProcessLister {
  return async () => {
    const result = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LIST_COMMAND],
      { timeoutMs: 30_000, maxOutputChars: 4_000_000 },
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`No se pudo listar procesos (código ${String(result.exitCode)}).`);
    }
    return parseProcessList(result.stdout);
  };
}

/**
 * Procesos huérfanos: los que corren un ejecutable dentro de `binDir`
 * (yt-dlp, ffmpeg, ffprobe, deno), excepto este mismo proceso.
 *
 * Se identifican por la ruta del ejecutable y no por PIDs guardados porque
 * Windows reutiliza los PID: después de un reinicio, "el PID del job anterior"
 * puede ser un proceso cualquiera.
 */
export function selectOrphanProcesses(
  processes: readonly ProcessInfo[],
  binDir: string,
  selfPid: number,
): ProcessInfo[] {
  const prefix = path.resolve(binDir).toLowerCase() + path.sep;
  return processes.filter(
    (proc) =>
      proc.pid !== selfPid && path.resolve(proc.executablePath).toLowerCase().startsWith(prefix),
  );
}
