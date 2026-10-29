import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

/**
 * Configuración del server. Única fuente: el archivo `.env` (SPEC §9).
 *
 * - Las rutas relativas se resuelven contra la carpeta del `.env`, no contra el
 *   directorio de trabajo: así el servicio de Windows funciona igual sin
 *   importar desde dónde lo arranque WinSW.
 * - La variable de entorno `STI_ENV_FILE` permite apuntar a un `.env` fuera del
 *   repo (útil en el servidor). Es la única que se lee de `process.env`.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const intInRange = (min: number, max: number, defaultValue: number) =>
  z.coerce
    .number({ error: 'Tiene que ser un número.' })
    .int({ error: 'Tiene que ser un número entero.' })
    .min(min, { error: `Mínimo ${min}.` })
    .max(max, { error: `Máximo ${max}.` })
    .default(defaultValue);

const requiredPath = z
  .string({ error: 'Es obligatoria.' })
  .trim()
  .min(1, { error: 'Es obligatoria.' });

const optionalPath = z.preprocess(emptyToUndefined, z.string().trim().optional());

const rawEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: intInRange(1, 65535, 3000),
    HTTPS_CERT_PATH: optionalPath,
    HTTPS_KEY_PATH: optionalPath,

    STORAGE_DIR: requiredPath,
    DATA_DIR: requiredPath,
    LOG_DIR: requiredPath,
    BIN_DIR: requiredPath,

    YTDLP_PATH: optionalPath,
    FFMPEG_PATH: optionalPath,
    FFPROBE_PATH: optionalPath,

    MAX_CONCURRENT_JOBS: intInRange(1, 8, 2),
    MAX_UPLOAD_MB: intInRange(1, 50_000, 2048),
    RETENTION_DAYS: intInRange(0, 3650, 14),
    MIN_FREE_DISK_GB: z.coerce
      .number({ error: 'Tiene que ser un número.' })
      .min(0, { error: 'No puede ser negativo.' })
      .default(5),

    // Extractores de yt-dlp (D-040). Sin "generic" no se descarga de cualquier página.
    YTDLP_EXTRACTORS: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_:.*+-]+(,[A-Za-z0-9_:.*+-]+)*$/, {
        error: 'Lista de extractores separados por comas, p. ej. "default,-generic".',
      })
      .default('default,-generic'),
    // Segunda capa contra SSRF: rechazar URLs que apunten a la red interna.
    BLOCK_PRIVATE_URLS: z.stringbool({ error: 'Tiene que ser true o false.' }).default(true),
  })
  .superRefine((env, ctx) => {
    const hasCert = env.HTTPS_CERT_PATH !== undefined;
    const hasKey = env.HTTPS_KEY_PATH !== undefined;
    if (hasCert !== hasKey) {
      ctx.addIssue({
        code: 'custom',
        path: [hasCert ? 'HTTPS_KEY_PATH' : 'HTTPS_CERT_PATH'],
        message: 'HTTPS_CERT_PATH y HTTPS_KEY_PATH van juntas: definí las dos o ninguna.',
      });
    }
    // HTTP sin cifrar solo en localhost (SPEC §9).
    if (!hasCert && !LOOPBACK_HOSTS.has(env.HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['HOST'],
        message: `Sin HTTPS solo se puede escuchar en localhost (127.0.0.1). Para "${env.HOST}" configurá HTTPS_CERT_PATH y HTTPS_KEY_PATH.`,
      });
    }
  });

export type ToolPaths = {
  ytdlp: string;
  ffmpeg: string;
  ffprobe: string;
  deno: string;
};

export type Config = {
  nodeEnv: 'development' | 'production';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  server: {
    host: string;
    port: number;
    https: { certPath: string; keyPath: string } | null;
  };
  paths: {
    storage: string;
    data: string;
    logs: string;
    bin: string;
  };
  tools: ToolPaths;
  limits: {
    maxConcurrentJobs: number;
    maxUploadBytes: number;
    retentionDays: number;
    minFreeDiskBytes: number;
  };
  download: {
    ytdlpExtractors: string;
    blockPrivateUrls: boolean;
  };
};

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Valida las variables y arma la configuración tipada. Función pura: no lee
 * archivos ni `process.env`, para poder testearla.
 *
 * @param raw     variables tal como vienen del `.env`
 * @param baseDir carpeta contra la que se resuelven las rutas relativas
 */
export function parseConfig(raw: Record<string, string | undefined>, baseDir: string): Config {
  const result = rawEnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(general)';
      return `  - ${key}: ${issue.message}`;
    });
    throw new ConfigError(`Configuración inválida en .env:\n${lines.join('\n')}`);
  }
  const env = result.data;
  const resolve = (p: string) => path.resolve(baseDir, p);
  const bin = resolve(env.BIN_DIR);

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    server: {
      host: env.HOST,
      port: env.PORT,
      https:
        env.HTTPS_CERT_PATH !== undefined && env.HTTPS_KEY_PATH !== undefined
          ? { certPath: resolve(env.HTTPS_CERT_PATH), keyPath: resolve(env.HTTPS_KEY_PATH) }
          : null,
    },
    paths: {
      storage: resolve(env.STORAGE_DIR),
      data: resolve(env.DATA_DIR),
      logs: resolve(env.LOG_DIR),
      bin,
    },
    tools: {
      ytdlp: env.YTDLP_PATH !== undefined ? resolve(env.YTDLP_PATH) : path.join(bin, 'yt-dlp.exe'),
      ffmpeg:
        env.FFMPEG_PATH !== undefined ? resolve(env.FFMPEG_PATH) : path.join(bin, 'ffmpeg.exe'),
      ffprobe:
        env.FFPROBE_PATH !== undefined ? resolve(env.FFPROBE_PATH) : path.join(bin, 'ffprobe.exe'),
      // Deno siempre sale de BIN_DIR: yt-dlp lo recibe con --js-runtimes deno:<ruta>.
      deno: path.join(bin, 'deno.exe'),
    },
    limits: {
      maxConcurrentJobs: env.MAX_CONCURRENT_JOBS,
      maxUploadBytes: env.MAX_UPLOAD_MB * MB,
      retentionDays: env.RETENTION_DAYS,
      minFreeDiskBytes: Math.round(env.MIN_FREE_DISK_GB * GB),
    },
    download: {
      ytdlpExtractors: env.YTDLP_EXTRACTORS,
      blockPrivateUrls: env.BLOCK_PRIVATE_URLS,
    },
  };
}

/** Ruta del `.env`: `STI_ENV_FILE` si está definida, si no `<repo>/.env`. */
export function resolveEnvFilePath(repoRoot: string, processEnv = process.env): string {
  const override = processEnv.STI_ENV_FILE?.trim();
  return override ? path.resolve(override) : path.join(repoRoot, '.env');
}

/** Lee el `.env` del disco y lo valida. Si falta o es inválido, lanza ConfigError. */
export function loadConfig(envFilePath: string): Config {
  let content: string;
  try {
    content = readFileSync(envFilePath, 'utf8');
  } catch {
    throw new ConfigError(
      `No se encontró el archivo de configuración: ${envFilePath}\n` +
        'Copiá .env.example a .env (o corré scripts/setup.ps1) y revisá los valores.',
    );
  }
  return parseConfig(parseEnv(content), path.dirname(envFilePath));
}
