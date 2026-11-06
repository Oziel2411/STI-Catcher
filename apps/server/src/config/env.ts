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
const optionalText = optionalPath;

/** "a@x.com, b@y.com" → lista validada (vacío = nadie). */
const emailList = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value
          .split(/[,;]/)
          .map((part) => part.trim())
          .filter((part) => part !== '')
      : [],
  z.array(z.email({ error: (issue) => `«${String(issue.input)}» no es una dirección de mail.` })),
);

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

    // Topes del GIF (D-043): un GIF largo o grande pesa cientos de MB.
    GIF_MAX_SECONDS: intInRange(1, 300, 30),
    GIF_MAX_FPS: intInRange(1, 30, 15),
    GIF_MAX_WIDTH: intInRange(64, 1920, 800),

    // Grabación: sin fragmentos nuevos durante este tiempo se da por terminada (D-032).
    RECORDING_IDLE_MINUTES: intInRange(1, 60, 2),

    // Aviso por mail al terminar una grabación (D-099). Sin SMTP_HOST o sin
    // MAIL_TO no se manda nada.
    SMTP_HOST: optionalText,
    SMTP_PORT: intInRange(1, 65_535, 465),
    /** ssl: TLS desde el principio (puerto 465). starttls: texto y después TLS (587). */
    SMTP_SECURITY: z.enum(['ssl', 'starttls']).default('ssl'),
    SMTP_USER: optionalText,
    SMTP_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
    MAIL_FROM: optionalText,
    MAIL_TO: emailList,

    // Dirección con la que los compañeros entran (D-104): va en el link para
    // recuperar la contraseña. Sin ella (o sin SMTP) esa opción no aparece.
    PUBLIC_URL: z.preprocess(
      emptyToUndefined,
      z
        .url({
          protocol: /^https?$/,
          error: 'Tiene que ser una dirección web, p. ej. https://192.168.3.115:3000',
        })
        .optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.SMTP_USER !== undefined && env.SMTP_PASSWORD === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_PASSWORD'],
        message: 'Con SMTP_USER hace falta SMTP_PASSWORD (la contraseña de la casilla).',
      });
    }
    const from = env.MAIL_FROM ?? env.SMTP_USER;
    if (env.SMTP_HOST !== undefined && from !== undefined && !z.email().safeParse(from).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM'],
        message: `«${from}» no es una dirección de mail (MAIL_FROM, o SMTP_USER si no hay MAIL_FROM).`,
      });
    }
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
  recording: {
    idleMinutes: number;
  };
  /** Dirección pública de la app, sin / al final. null si no está (D-104). */
  publicUrl: string | null;
  /** null si falta SMTP_HOST. Ver D-099. */
  mail: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; password: string } | null;
    from: string;
    to: string[];
  } | null;
  gif: {
    maxSeconds: number;
    maxFps: number;
    maxWidth: number;
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
    recording: {
      idleMinutes: env.RECORDING_IDLE_MINUTES,
    },
    publicUrl: env.PUBLIC_URL === undefined ? null : env.PUBLIC_URL.replace(/\/+$/, ''),
    mail:
      env.SMTP_HOST === undefined
        ? null
        : {
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURITY === 'ssl',
            auth:
              env.SMTP_USER !== undefined && env.SMTP_PASSWORD !== undefined
                ? { user: env.SMTP_USER, password: env.SMTP_PASSWORD }
                : null,
            from: env.MAIL_FROM ?? env.SMTP_USER ?? `sti-catcher@${env.SMTP_HOST}`,
            to: env.MAIL_TO,
          },
    gif: {
      maxSeconds: env.GIF_MAX_SECONDS,
      maxFps: env.GIF_MAX_FPS,
      maxWidth: env.GIF_MAX_WIDTH,
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
