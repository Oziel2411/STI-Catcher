import path from 'node:path';
import type {
  DownloadFormat,
  JobPhase,
  ProbeResponse,
  ResolutionOption,
  VideoCodecFamily,
  VideoMode,
} from '@sti-catcher/shared';
import { z } from 'zod';
import type { CommandRunner, StreamingRunner } from './process.ts';

// --- Argumentos -----------------------------------------------------------------

export type YtdlpBaseOptions = {
  /** Valor de --use-extractors (D-040). */
  extractors: string;
  denoPath: string;
  cacheDir: string;
};

/**
 * Opciones comunes a toda ejecución.
 * - `--ignore-config`: nada de un yt-dlp.conf del sistema cambia el comportamiento.
 * - `--no-playlist`: siempre un solo video (SPEC §2).
 * - Las opciones con valor que podría empezar con "-" van como `--opcion=valor`
 *   en un solo argumento, para que yt-dlp no lo lea como otra opción.
 */
export function buildBaseArgs({ extractors, denoPath, cacheDir }: YtdlpBaseOptions): string[] {
  return [
    '--ignore-config',
    '--no-playlist',
    '--color',
    'no_color',
    '--encoding',
    'utf-8',
    `--use-extractors=${extractors}`,
    '--js-runtimes',
    `deno:${denoPath}`,
    '--cache-dir',
    cacheDir,
  ];
}

/** `yt-dlp -J`: metadatos y formatos en JSON, sin descargar. La URL siempre después de `--`. */
export function buildProbeArgs(url: string, base: YtdlpBaseOptions): string[] {
  return [...buildBaseArgs(base), '-J', '--', url];
}

export const PROGRESS_PREFIX = 'STI_PROGRESS ';
export const POSTPROCESS_PREFIX = 'STI_POSTPROCESS ';
export const INFO_PREFIX = 'STI_INFO ';

/** Líneas parseables: campos separados por "|"; yt-dlp escribe "NA" cuando no hay dato. */
const PROGRESS_ARGS = [
  '--newline',
  '--progress',
  '--progress-delta',
  '0.5',
  '--progress-template',
  `download:${PROGRESS_PREFIX}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`,
  '--progress-template',
  `postprocess:${POSTPROCESS_PREFIX}%(progress.status)s|%(progress.postprocessor)s`,
  // Antes de descargar: título y formato elegido (para saber cuántos streams se bajan).
  // --print implica --quiet; --progress mantiene el progreso y --no-simulate la descarga.
  '--print',
  `before_dl:${INFO_PREFIX}%(.{title,duration,extractor_key,webpage_url,format_id})j`,
  '--no-simulate',
];

export type FormatSelection = {
  /** Valor de -f. */
  format: string;
  /** Valor de -S (orden de preferencia). */
  sort: string;
  /** Opciones de postproceso. */
  extra: string[];
};

const heightFilter = (maxHeight: number | null) =>
  maxHeight === null ? '' : `[height<=${String(maxHeight)}]`;

/**
 * Qué formatos pide yt-dlp (SPEC §5). Medido con "Me at the zoo": sin esto,
 * yt-dlp elige AV1 + Opus por defecto.
 *
 * - Video: `bv` (solo video) + `ba` (solo audio), con `b` (combinado) de respaldo
 *   para sitios que no separan los streams. No se usa `bv*`: también acepta
 *   formatos que ya traen audio y, como se prefiere AAC, un combinado de baja
 *   resolución le ganaba al video solo (medido).
 * - compat: `-S vcodec:h264` primero → la mejor H.264 que no supere la altura.
 * - quality: sin preferencia de codec (yt-dlp prefiere AV1 > VP9 > H.264).
 * - recode: igual que quality; después se recodifica con ffmpeg (DownloadRunner).
 * - Audio: AAC preferido (m4a abre en todos lados; Opus en MP4 no tanto).
 * - Canales: `channels:2` = estéreo como máximo, salvo en "Máxima calidad".
 *   Medido con Big Buck Bunny: sin esto se elegía AAC 5.1 de 384 kbps (+20 MB
 *   en un video de 360p), que algunos reproductores y editores manejan mal; y
 *   MP3 no admite más de 2 canales.
 */
export function selectFormat(
  format: DownloadFormat,
  maxHeight: number | null,
  mode: VideoMode,
): FormatSelection {
  const STEREO_AAC = 'channels:2,acodec:aac';
  if (format === 'mp3') {
    return {
      format: 'ba/b',
      sort: STEREO_AAC,
      extra: ['-x', '--audio-format', 'mp3', '--audio-quality', '0'],
    };
  }
  if (format === 'm4a') {
    // Si el audio ya es AAC solo se cambia el contenedor, sin recodificar.
    return {
      format: 'ba[acodec^=mp4a]/ba/b',
      sort: STEREO_AAC,
      extra: ['-x', '--audio-format', 'm4a'],
    };
  }
  const h = heightFilter(maxHeight);
  const res = maxHeight === null ? '' : `res:${String(maxHeight)},`;
  return {
    // Con altura, el último respaldo (sin filtro) cubre sitios que no informan la altura.
    format: maxHeight === null ? 'bv+ba/b' : `bv${h}+ba/b${h}/bv+ba/b`,
    sort: mode === 'compat' ? `vcodec:h264,${res}${STEREO_AAC}` : `${res}acodec:aac`,
    // merge: cuando se unen video y audio; remux: cuando el sitio da un solo archivo (p. ej. webm).
    extra: ['--merge-output-format', 'mp4', '--remux-video', 'mp4'],
  };
}

export type DownloadArgsOptions = {
  url: string;
  format: DownloadFormat;
  maxHeight: number | null;
  mode: VideoMode;
  /** Plantilla de salida, p. ej. `D:\storage\tmp\<jobId>.%(ext)s`. */
  outputTemplate: string;
  ffmpegPath: string;
  base: YtdlpBaseOptions;
};

export function buildDownloadArgs(options: DownloadArgsOptions): string[] {
  const selection = selectFormat(options.format, options.maxHeight, options.mode);
  return [
    ...buildBaseArgs(options.base),
    ...PROGRESS_ARGS,
    '-f',
    selection.format,
    '-S',
    selection.sort,
    ...selection.extra,
    '--ffmpeg-location',
    options.ffmpegPath,
    // La fecha del archivo es la de descarga (la usa la retención), no la de publicación.
    '--no-mtime',
    '-o',
    options.outputTemplate,
    '--',
    options.url,
  ];
}

// --- Análisis (-J) ----------------------------------------------------------------

const formatSchema = z.looseObject({
  format_id: z.string(),
  vcodec: z.string().nullish(),
  acodec: z.string().nullish(),
  height: z.number().nullish(),
});

const infoSchema = z.looseObject({
  _type: z.string().optional(),
  title: z.string().nullish(),
  thumbnail: z.string().nullish(),
  duration: z.number().nullish(),
  extractor_key: z.string().nullish(),
  webpage_url: z.string().nullish(),
  uploader: z.string().nullish(),
  live_status: z.string().nullish(),
  is_live: z.boolean().nullish(),
  vcodec: z.string().nullish(),
  acodec: z.string().nullish(),
  height: z.number().nullish(),
  formats: z.array(formatSchema).nullish(),
});

/** "avc1.4D401F" → h264, "vp09.00.10.08" → vp9, "av01.0.08M.08" → av1. */
export function codecFamily(vcodec: string): VideoCodecFamily {
  const codec = vcodec.toLowerCase();
  if (codec.startsWith('avc') || codec.startsWith('h264')) return 'h264';
  if (codec.startsWith('hev') || codec.startsWith('hvc') || codec.startsWith('h265')) return 'h265';
  if (codec.startsWith('vp09') || codec.startsWith('vp9')) return 'vp9';
  if (codec.startsWith('av01') || codec === 'av1') return 'av1';
  return 'other';
}

/** "none" y "" significan "no hay" (p. ej. vcodec de un formato solo audio). */
const hasCodec = (codec: string | null | undefined): codec is string =>
  typeof codec === 'string' && codec !== '' && codec !== 'none';

export class ProbeParseError extends Error {
  override name = 'ProbeParseError';
}

/**
 * Convierte la salida de `yt-dlp -J` en lo que necesita la UI: resoluciones
 * disponibles con sus codecs y la mayor resolución en H.264 (para el aviso de codec).
 */
export function mapProbeOutput(raw: unknown, requestedUrl: string): ProbeResponse {
  const parsed = infoSchema.safeParse(raw);
  if (!parsed.success) throw new ProbeParseError('Salida de yt-dlp -J con formato inesperado');
  const info = parsed.data;
  if (info._type === 'playlist' || info._type === 'multi_video') {
    throw new ProbeParseError('playlist');
  }

  // Algunos sitios no listan formatos: el propio info es el único formato.
  const formats = info.formats?.length
    ? info.formats
    : [{ format_id: 'default', vcodec: info.vcodec, acodec: info.acodec, height: info.height }];

  const byHeight = new Map<number, Set<VideoCodecFamily>>();
  let hasVideo = false;
  let hasAudio = false;
  for (const f of formats) {
    if (hasCodec(f.acodec)) hasAudio = true;
    if (!hasCodec(f.vcodec)) continue;
    hasVideo = true;
    if (typeof f.height !== 'number' || f.height <= 0) continue;
    const codecs = byHeight.get(f.height) ?? new Set<VideoCodecFamily>();
    codecs.add(codecFamily(f.vcodec));
    byHeight.set(f.height, codecs);
  }

  const order: VideoCodecFamily[] = ['h264', 'h265', 'vp9', 'av1', 'other'];
  const resolutions: ResolutionOption[] = [...byHeight.entries()]
    .sort(([a], [b]) => b - a)
    .map(([height, codecs]) => ({
      height,
      codecs: order.filter((codec) => codecs.has(codec)),
    }));
  const maxH264Height = resolutions.find((r) => r.codecs.includes('h264'))?.height ?? null;

  return {
    url: info.webpage_url ?? requestedUrl,
    title: info.title?.trim() || 'Sin título',
    site: info.extractor_key ?? 'Desconocido',
    uploader: info.uploader ?? null,
    thumbnailUrl: info.thumbnail ?? null,
    durationSeconds: typeof info.duration === 'number' && info.duration >= 0 ? info.duration : null,
    isLive: info.is_live === true || info.live_status === 'is_live',
    hasVideo,
    hasAudio,
    resolutions,
    maxH264Height,
  };
}

// --- Progreso de descarga -----------------------------------------------------------

export type DownloadInfo = {
  title: string | null;
  durationSeconds: number | null;
  site: string | null;
  webpageUrl: string | null;
  formatId: string | null;
};

const infoLineSchema = z.object({
  title: z.string().nullish(),
  duration: z.number().nullish(),
  extractor_key: z.string().nullish(),
  webpage_url: z.string().nullish(),
  format_id: z.string().nullish(),
});

export type YtdlpProgressUpdate = {
  phase: JobPhase;
  percent: number | null;
  speedBytesPerSecond: number | null;
  etaSeconds: number | null;
};

const numberOrNull = (value: string | undefined): number | null => {
  if (value === undefined || value === 'NA' || value === 'None' || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Postprocesadores de yt-dlp → fase para el usuario. */
function postprocessPhase(name: string): JobPhase {
  if (name === 'Merger') return 'merging';
  if (name === 'ExtractAudio' || name.includes('Convertor')) return 'converting';
  return 'processing';
}

/**
 * Peso de cada stream en el porcentaje total. Con video + audio separados, el
 * video es casi todo el tamaño: repartir 50/50 haría que la barra llegue a la
 * mitad enseguida y después se quede quieta.
 */
const streamWeights = (count: number): number[] =>
  count === 2 ? [0.9, 0.1] : Array.from({ length: count }, () => 1 / count);

/**
 * Interpreta las líneas que generan `PROGRESS_ARGS` (stdout y stderr).
 * yt-dlp reporta cada stream (video, audio) de 0 a 100 por separado; acá se
 * combinan en un porcentaje total.
 */
export function createYtdlpProgressTracker() {
  let weights = [1];
  let completed = 0;
  let lastPercent: number | null = null;

  const completedWeight = () => weights.slice(0, completed).reduce((sum, w) => sum + w, 0);

  return {
    /** Línea STI_INFO → datos del video. null si no es una línea de info válida. */
    parseInfo(line: string): DownloadInfo | null {
      if (!line.startsWith(INFO_PREFIX)) return null;
      let data: unknown;
      try {
        data = JSON.parse(line.slice(INFO_PREFIX.length));
      } catch {
        return null;
      }
      const parsed = infoLineSchema.safeParse(data);
      if (!parsed.success) return null;
      const formatId = parsed.data.format_id ?? null;
      weights = streamWeights(Math.max(1, formatId ? formatId.split('+').length : 1));
      completed = 0;
      return {
        title: parsed.data.title ?? null,
        durationSeconds: parsed.data.duration ?? null,
        site: parsed.data.extractor_key ?? null,
        webpageUrl: parsed.data.webpage_url ?? null,
        formatId,
      };
    },

    /** Línea de progreso o postproceso → actualización. null para cualquier otra línea. */
    push(line: string): YtdlpProgressUpdate | null {
      if (line.startsWith(PROGRESS_PREFIX)) {
        const [status, downloaded, total, estimate, speed, eta] = line
          .slice(PROGRESS_PREFIX.length)
          .split('|');
        const current = weights[Math.min(completed, weights.length - 1)] ?? 1;
        if (status === 'finished') {
          completed = Math.min(completed + 1, weights.length);
          lastPercent = Math.min(100, completedWeight() * 100);
          return {
            phase: 'downloading',
            percent: lastPercent,
            speedBytesPerSecond: null,
            etaSeconds: null,
          };
        }
        if (status !== 'downloading') return null;
        const done = numberOrNull(downloaded);
        const size = numberOrNull(total) ?? numberOrNull(estimate);
        const fraction =
          done !== null && size !== null && size > 0 ? Math.min(1, done / size) : null;
        lastPercent =
          fraction === null
            ? lastPercent
            : Math.min(100, (completedWeight() + fraction * current) * 100);
        return {
          phase: 'downloading',
          percent: lastPercent,
          speedBytesPerSecond: numberOrNull(speed),
          etaSeconds: numberOrNull(eta),
        };
      }
      if (line.startsWith(POSTPROCESS_PREFIX)) {
        const [status, name = ''] = line.slice(POSTPROCESS_PREFIX.length).split('|');
        if (status !== 'started') return null;
        // Los postprocesos no informan porcentaje: la UI muestra la fase sin barra.
        return {
          phase: postprocessPhase(name),
          percent: null,
          speedBytesPerSecond: null,
          etaSeconds: null,
        };
      }
      return null;
    },
  };
}

// --- Errores ----------------------------------------------------------------------

export type YtdlpErrorCode =
  | 'PRIVATE'
  | 'UNAVAILABLE'
  | 'GEO_RESTRICTED'
  | 'AGE_RESTRICTED'
  | 'BOT_CHECK'
  | 'LOGIN_REQUIRED'
  | 'UNSUPPORTED_SITE'
  | 'INVALID_URL'
  | 'DRM'
  | 'LIVE'
  | 'RATE_LIMITED'
  | 'FORMAT_UNAVAILABLE'
  | 'NETWORK'
  | 'OUTDATED'
  | 'UNKNOWN';

export type YtdlpErrorInfo = { code: YtdlpErrorCode; message: string };

const UPDATE_HINT = 'Pedile a quien administra el servidor que corra scripts\\update-ytdlp.ps1.';

/**
 * Reglas en orden: la primera que coincide gana. Los textos de los patrones
 * son los que imprimen yt-dlp y YouTube (ver test/fixtures/README.md).
 */
const ERROR_RULES: { code: YtdlpErrorCode; pattern: RegExp; message: string }[] = [
  {
    code: 'PRIVATE',
    pattern: /private video|this video is private/i,
    message: 'El video es privado.',
  },
  {
    code: 'GEO_RESTRICTED',
    pattern:
      /not made this video available in your country|geo.?restrict|not available in your country/i,
    message: 'El video tiene restricción geográfica: no está disponible en este país.',
  },
  {
    code: 'AGE_RESTRICTED',
    pattern: /confirm your age|age.?restrict|inappropriate for some users/i,
    message: 'El video tiene restricción de edad y requiere iniciar sesión: no se puede descargar.',
  },
  {
    code: 'BOT_CHECK',
    pattern: /confirm you.re not a bot|captcha/i,
    message:
      'El sitio está pidiendo verificar que no es un robot y bloqueó la descarga desde este servidor. Probá más tarde.',
  },
  {
    code: 'RATE_LIMITED',
    pattern: /HTTP Error 429|Too Many Requests|rate.?limit|isn.t available, try again later/i,
    message: 'El sitio está limitando las descargas desde este servidor. Probá en un rato.',
  },
  {
    code: 'DRM',
    pattern: /DRM protected/i,
    message: 'El contenido está protegido con DRM: no se puede descargar.',
  },
  {
    code: 'LIVE',
    pattern: /live event will begin|Premieres in|This live event|is currently live/i,
    message:
      'Es una transmisión en vivo o un estreno que todavía no terminó: no se puede descargar.',
  },
  {
    code: 'LOGIN_REQUIRED',
    pattern:
      /login required|log in|sign in|members.only|join this channel|requires authentication|use --cookies/i,
    message: 'El video requiere iniciar sesión en el sitio: no se puede descargar.',
  },
  {
    code: 'UNAVAILABLE',
    pattern:
      /video (?:is )?unavailable|has been removed|no longer available|does not exist|not found|404|terminated|deleted/i,
    message: 'El video no existe o fue eliminado.',
  },
  {
    code: 'INVALID_URL',
    pattern: /looks truncated|Incomplete YouTube ID|is not a valid URL/i,
    message: 'El link parece incompleto. Copialo de nuevo desde el sitio.',
  },
  {
    code: 'UNSUPPORTED_SITE',
    pattern: /Unsupported URL|No suitable extractor/i,
    message: 'El sitio no está soportado, o el link no apunta a un video.',
  },
  {
    code: 'FORMAT_UNAVAILABLE',
    pattern: /Requested format is not available/i,
    message: 'El formato pedido no está disponible para este video. Probá con otra resolución.',
  },
  {
    code: 'OUTDATED',
    pattern:
      /latest version|nsig extraction failed|signature extraction failed|Unable to extract|please report this issue/i,
    message: `yt-dlp está desactualizado y el sitio cambió: hay que actualizarlo. ${UPDATE_HINT}`,
  },
  {
    code: 'NETWORK',
    pattern:
      /getaddrinfo failed|Name or service not known|timed out|Connection (?:refused|reset)|urlopen error|Unable to download webpage/i,
    message: 'No se pudo conectar con el sitio. Revisá la conexión a internet del servidor.',
  },
];

/**
 * Traduce la salida de error de yt-dlp a un mensaje entendible (SPEC §5).
 * Se miran primero las líneas "ERROR:", que son las que explican el motivo.
 */
export function classifyYtdlpError(stderrLines: readonly string[]): YtdlpErrorInfo {
  const errorLines = stderrLines.filter((line) => line.startsWith('ERROR:'));
  const text = (errorLines.length > 0 ? errorLines : stderrLines).join('\n');
  const rule = ERROR_RULES.find((r) => r.pattern.test(text));
  if (rule) return { code: rule.code, message: rule.message };
  return {
    code: 'UNKNOWN',
    message: 'yt-dlp no pudo procesar el video. El detalle quedó en el log del servidor.',
  };
}

// --- Ejecución ---------------------------------------------------------------------

/** yt-dlp terminó con error. `info` es el motivo para el usuario; `stderrTail` va al log. */
export class YtdlpError extends Error {
  override name = 'YtdlpError';
  constructor(
    readonly info: YtdlpErrorInfo,
    readonly stderrTail: readonly string[],
  ) {
    super(`yt-dlp falló: ${info.code}`);
  }
}

export type YtdlpDeps = {
  runCommand: CommandRunner;
  runStreaming: StreamingRunner;
  ytdlpPath: string;
  ffmpegPath: string;
  base: YtdlpBaseOptions;
  /** Carpeta para DENO_DIR (D-012): la cuenta del servicio no tiene un perfil normal. */
  denoDir: string;
};

export type YtdlpDownloadOptions = Omit<DownloadArgsOptions, 'base' | 'ffmpegPath'> & {
  signal: AbortSignal;
  onInfo: (info: DownloadInfo) => void;
  onProgress: (update: YtdlpProgressUpdate) => void;
};

export type Ytdlp = {
  probe: (url: string) => Promise<ProbeResponse>;
  download: (options: YtdlpDownloadOptions) => Promise<void>;
};

/** El análisis de YouTube tarda 5–10 s; con red lenta puede tardar más. */
const PROBE_TIMEOUT_MS = 90_000;
/** La salida de -J de YouTube pesa 100–200 KB; se deja margen amplio. */
const PROBE_MAX_OUTPUT = 32 * 1024 * 1024;

export function createYtdlp(deps: YtdlpDeps): Ytdlp {
  const env = {
    ...process.env,
    DENO_DIR: deps.denoDir,
    // yt-dlp.exe es Python: que la salida sea UTF-8 aunque la consola use otra página de códigos.
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };

  return {
    async probe(url) {
      const result = await deps.runCommand(deps.ytdlpPath, buildProbeArgs(url, deps.base), {
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputChars: PROBE_MAX_OUTPUT,
        env,
      });
      const stderr = result.stderr.split(/\r?\n/).filter((line) => line.length > 0);
      if (result.timedOut) {
        throw new YtdlpError(
          { code: 'NETWORK', message: 'El sitio tardó demasiado en responder. Probá de nuevo.' },
          stderr,
        );
      }
      if (result.exitCode !== 0) throw new YtdlpError(classifyYtdlpError(stderr), stderr);
      let json: unknown;
      try {
        json = JSON.parse(result.stdout);
      } catch {
        throw new YtdlpError(classifyYtdlpError(stderr), stderr);
      }
      try {
        return mapProbeOutput(json, url);
      } catch (error) {
        if (error instanceof ProbeParseError && error.message === 'playlist') {
          throw new YtdlpError(
            {
              code: 'INVALID_URL',
              message: 'El link es de una lista de reproducción. Pegá el link de un solo video.',
            },
            stderr,
          );
        }
        throw error;
      }
    },

    async download({ signal, onInfo, onProgress, ...args }) {
      const tracker = createYtdlpProgressTracker();
      const onLine = (line: string) => {
        const info = tracker.parseInfo(line);
        if (info) {
          onInfo(info);
          return;
        }
        const update = tracker.push(line);
        if (update) onProgress(update);
      };
      const result = await deps.runStreaming(
        deps.ytdlpPath,
        buildDownloadArgs({ ...args, base: deps.base, ffmpegPath: deps.ffmpegPath }),
        {
          signal,
          env,
          // El progreso de descarga sale por stdout y el de postproceso por stderr (medido).
          onStdoutLine: onLine,
          onStderrLine: onLine,
          stderrTailLines: 40,
        },
      );
      if (result.exitCode !== 0) {
        throw new YtdlpError(classifyYtdlpError(result.stderrTail), result.stderrTail);
      }
    },
  };
}

/** Plantilla de salida: siempre `<jobId>.<ext>` (SPEC §8: nada del título en el nombre del archivo). */
export function outputTemplate(tempDir: string, jobId: string): string {
  return path.join(tempDir, `${jobId}.%(ext)s`);
}
