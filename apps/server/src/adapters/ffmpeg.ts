import type { StreamingRunner } from './process.ts';

/** Opciones comunes a toda ejecución de ffmpeg. */
const BASE_ARGS = [
  '-hide_banner',
  // Sin stdin: ffmpeg no espera teclas ('q') ni se cuelga leyendo la consola.
  '-nostdin',
  '-y',
  // Progreso parseable por stdout, cada medio segundo; sin la línea de stats en stderr.
  '-progress',
  'pipe:1',
  '-stats_period',
  '0.5',
  '-nostats',
] as const;

export type SelftestArgsOptions = {
  durationSeconds: number;
  outputPath: string;
};

/**
 * Video de prueba de 1280×720 a 30 fps con un tono de 440 Hz, en H.264 + AAC.
 * Sale de los generadores internos de ffmpeg (`lavfi`): no necesita internet
 * ni archivos de entrada.
 *
 * `-re` lee las entradas a velocidad real: el test dura lo mismo que el video.
 * Así se puede ver el progreso y probar la cancelación a mano; sin `-re`, un
 * minuto de video se codifica en pocos segundos.
 */
export function buildSelftestArgs({ durationSeconds, outputPath }: SelftestArgsOptions): string[] {
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError(`Duración inválida: ${durationSeconds}`);
  }
  const d = String(durationSeconds);
  return [
    ...BASE_ARGS,
    '-re',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=30:duration=${d}`,
    '-re',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${d}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    // Sin -shortest: las dos entradas ya duran lo mismo, y -shortest hace que
    // ffmpeg retenga la salida varios segundos para emparejar audio y video
    // (medido: el progreso quedaba clavado en 0,5 s durante ~9 s).
    '-movflags',
    '+faststart',
    outputPath,
  ];
}

export type FfmpegProgress = {
  outTimeSeconds: number | null;
  percent: number | null;
  speedRatio: number | null;
  etaSeconds: number | null;
  done: boolean;
};

/**
 * Interpreta la salida de `-progress pipe:1`: bloques de líneas `clave=valor`
 * que terminan con `progress=continue` o `progress=end`.
 *
 * El porcentaje se calcula contra la duración total (de ffprobe, o la del
 * video de prueba). `out_time_us` está en microsegundos; `out_time_ms` también,
 * por un error histórico de ffmpeg, así que se usa `out_time_us`.
 *
 * Velocidad: el `speed=` de ffmpeg es un promedio desde el arranque, así que
 * arrastra la demora inicial y subestima durante mucho tiempo (medido: decía
 * 0,1x avanzando a 1x real, y el tiempo restante salía en minutos en vez de
 * segundos). Se calcula la velocidad instantánea entre bloques (video avanzado
 * ÷ tiempo de reloj) y se suaviza con un promedio móvil exponencial. El valor
 * de ffmpeg solo se usa hasta tener dos bloques.
 *
 * @param now reloj en milisegundos (inyectable para tests)
 * @returns un snapshot al cerrar cada bloque, null en las demás líneas
 */
export function createFfmpegProgressTracker(
  totalDurationSeconds: number | null,
  now: () => number = () => performance.now(),
) {
  /** Peso de la última medición en el promedio móvil. */
  const SMOOTHING = 0.3;
  let outTimeSeconds: number | null = null;
  let reportedSpeed: number | null = null;
  let smoothedSpeed: number | null = null;
  let previous: { outTime: number; at: number } | null = null;

  const updateSpeed = () => {
    if (outTimeSeconds === null) return;
    const at = now();
    if (previous !== null && at > previous.at && outTimeSeconds >= previous.outTime) {
      const instant = (outTimeSeconds - previous.outTime) / ((at - previous.at) / 1000);
      smoothedSpeed =
        smoothedSpeed === null ? instant : SMOOTHING * instant + (1 - SMOOTHING) * smoothedSpeed;
    }
    previous = { outTime: outTimeSeconds, at };
  };

  return {
    push(line: string): FfmpegProgress | null {
      const separator = line.indexOf('=');
      if (separator <= 0) return null;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();

      switch (key) {
        case 'out_time_us': {
          const micros = Number(value);
          if (Number.isFinite(micros) && micros >= 0) outTimeSeconds = micros / 1_000_000;
          return null;
        }
        case 'speed': {
          // "1.01x", "N/A" o " 0.998x"
          const ratio = Number.parseFloat(value);
          reportedSpeed = Number.isFinite(ratio) && ratio >= 0 ? ratio : null;
          return null;
        }
        case 'progress': {
          updateSpeed();
          const speedRatio = smoothedSpeed ?? reportedSpeed;
          const done = value === 'end';
          const hasTotal = totalDurationSeconds !== null && totalDurationSeconds > 0;
          let percent: number | null = null;
          let etaSeconds: number | null = null;
          if (done) {
            percent = 100;
            etaSeconds = 0;
          } else if (hasTotal && outTimeSeconds !== null) {
            percent = Math.min(100, Math.max(0, (outTimeSeconds / totalDurationSeconds) * 100));
            if (speedRatio !== null && speedRatio > 0) {
              etaSeconds = Math.max(0, (totalDurationSeconds - outTimeSeconds) / speedRatio);
            }
          }
          return { outTimeSeconds, percent, speedRatio, etaSeconds, done };
        }
        default:
          return null;
      }
    },
  };
}

/** ffmpeg terminó con error. `stderrTail` va al log; al usuario se le muestra un mensaje genérico. */
export class FfmpegError extends Error {
  override name = 'FfmpegError';
  constructor(
    readonly exitCode: number | null,
    readonly stderrTail: string[],
  ) {
    super(`ffmpeg terminó con código ${String(exitCode)}`);
  }
}

export type FfmpegRunOptions = {
  signal: AbortSignal;
  /** Para calcular el porcentaje. null si no se conoce. */
  totalDurationSeconds: number | null;
  onProgress?: (progress: FfmpegProgress) => void;
};

export type FfmpegRunner = (args: readonly string[], options: FfmpegRunOptions) => Promise<void>;

export function createFfmpegRunner(run: StreamingRunner, ffmpegPath: string): FfmpegRunner {
  return async (args, { signal, totalDurationSeconds, onProgress }) => {
    const tracker = createFfmpegProgressTracker(totalDurationSeconds);
    const result = await run(ffmpegPath, args, {
      signal,
      onStdoutLine: (line) => {
        const progress = tracker.push(line);
        if (progress) onProgress?.(progress);
      },
    });
    if (result.exitCode !== 0) {
      throw new FfmpegError(result.exitCode, result.stderrTail);
    }
  };
}
