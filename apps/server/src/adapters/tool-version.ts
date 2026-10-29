import type { ToolName } from '@sti-catcher/shared';
import type { CommandRunner } from './process.ts';

/** Argumento que imprime la versión de cada herramienta. */
const VERSION_ARGS: Record<ToolName, string[]> = {
  'yt-dlp': ['--version'],
  ffmpeg: ['-hide_banner', '-version'],
  ffprobe: ['-hide_banner', '-version'],
  deno: ['--version'],
};

/**
 * Extrae la versión de la salida de `--version` / `-version`.
 * Devuelve null si el formato no se reconoce.
 *
 * Ejemplos de salida real:
 *   yt-dlp  → "2026.10.20"
 *   ffmpeg  → "ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright (c) ..."
 *   ffprobe → "ffprobe version 9.0.2-essentials_build-www.gyan.dev Copyright (c) ..."
 *   deno    → "deno 2.6.3 (stable, release, x86_64-pc-windows-msvc)"
 */
export function parseToolVersion(tool: ToolName, stdout: string): string | null {
  const firstLine = stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  let match: RegExpMatchArray | null;
  switch (tool) {
    case 'yt-dlp':
      match = /^(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/.exec(firstLine);
      break;
    case 'ffmpeg':
    case 'ffprobe':
      match = new RegExp(`^${tool} version (\\S+)`).exec(firstLine);
      break;
    case 'deno':
      match = /^deno (\S+)/.exec(firstLine);
      break;
  }
  return match?.[1] ?? null;
}

export type ToolVersionResult = { version: string; error: null } | { version: null; error: string };

export type ToolVersionReader = (
  tool: ToolName,
  executablePath: string,
) => Promise<ToolVersionResult>;

const isNotFound = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * Consulta la versión de una herramienta. Nunca lanza: los problemas vuelven
 * como `error` con un mensaje para el usuario.
 */
export function createToolVersionReader(run: CommandRunner, timeoutMs = 20_000): ToolVersionReader {
  return async (tool, executablePath) => {
    try {
      const result = await run(executablePath, VERSION_ARGS[tool], { timeoutMs });
      if (result.timedOut) {
        return { version: null, error: 'No respondió a tiempo.' };
      }
      const version = parseToolVersion(tool, result.stdout);
      if (result.exitCode !== 0 || version === null) {
        return { version: null, error: 'Respondió con un formato inesperado.' };
      }
      return { version, error: null };
    } catch (error) {
      if (isNotFound(error)) {
        return { version: null, error: 'No encontrado. Corré scripts/setup.ps1.' };
      }
      return { version: null, error: 'No se pudo ejecutar.' };
    }
  };
}
