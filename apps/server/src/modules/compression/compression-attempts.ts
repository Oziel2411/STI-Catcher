import {
  BYTES_PER_MB,
  COMPRESSION_PRESETS,
  minVideoKbps,
  outputAudioKbps,
  outputVideo,
  planTargetSize,
  retryVideoKbps,
  targetMarginFor,
  targetSizeProblem,
} from '@sti-catcher/shared';
import type {
  CompressionOptions,
  CompressionSource,
  ResolvedEncoders,
  VideoEncoder,
} from '@sti-catcher/shared';

/**
 * Intentos de una compresión (D-108). Funciones puras: el runner solo corre
 * ffmpeg y les cuenta qué pasó.
 *
 * - La GPU falla (driver, la cuenta del servicio sin acceso): se repite por CPU.
 * - Con tamaño objetivo la salida pesó de más (la GPU no tiene dos pasadas):
 *   se repite una vez con un bitrate más bajo, en proporción a lo que se pasó.
 */

export type Attempt = {
  /** 1, 2, …: el primero y los reintentos. */
  number: number;
  encoder: VideoEncoder;
  /** null = calidad constante del preset. */
  videoKbps: number | null;
  /** Ya se repitió una vez por pesar de más (no se insiste). */
  sizeRetried: boolean;
};

export type AttemptOutcome =
  | { kind: 'encoded'; sizeBytes: number }
  /** ffmpeg falló con la GPU (con la CPU, el error se propaga sin reintentar). */
  | { kind: 'gpu-failed' };

export type AttemptDecision =
  | { kind: 'done' }
  | { kind: 'retry'; attempt: Attempt; reason: 'gpu-failed' | 'too-big' }
  | { kind: 'fail'; message: string };

/** Como mucho: el primero, uno por la GPU y uno por el tamaño. */
const MAX_ATTEMPTS = 3;

const mb = (bytes: number) => (bytes / BYTES_PER_MB).toFixed(1).replace('.', ',');

/** El primer intento, o por qué no se puede comprimir así. */
export function firstAttempt(
  source: CompressionSource,
  options: CompressionOptions,
  encoders: ResolvedEncoders,
): Attempt | { error: string } {
  const encoder = encoders[COMPRESSION_PRESETS[options.preset].codec];
  return withEncoder(source, options, encoder, 1, false);
}

function withEncoder(
  source: CompressionSource,
  options: CompressionOptions,
  encoder: VideoEncoder,
  number: number,
  sizeRetried: boolean,
): Attempt | { error: string } {
  if (options.target.mode === 'quality') {
    return { number, encoder, videoKbps: null, sizeRetried };
  }
  // El original ya entra: se comprime con la calidad del preset (apuntar al
  // tamaño pedido lo agrandaría). Si así se pasa, nextAttempt baja el bitrate.
  const targetBytes = options.target.megabytes * BYTES_PER_MB;
  if (!sizeRetried && (source.sizeBytes ?? Infinity) <= targetBytes) {
    return { number, encoder, videoKbps: null, sizeRetried };
  }
  const plan = planTargetSize(source, options, targetMarginFor(encoder));
  if (!plan.ok) return { error: targetSizeProblem(plan, options.target.megabytes) };
  return { number, encoder, videoKbps: plan.videoKbps, sizeRetried };
}

export function nextAttempt(
  source: CompressionSource,
  options: CompressionOptions,
  attempt: Attempt,
  outcome: AttemptOutcome,
): AttemptDecision {
  const last = attempt.number >= MAX_ATTEMPTS;

  if (outcome.kind === 'gpu-failed') {
    if (attempt.encoder === 'cpu' || last) {
      return { kind: 'fail', message: 'ffmpeg no pudo comprimir el archivo.' };
    }
    const retry = withEncoder(source, options, 'cpu', attempt.number + 1, attempt.sizeRetried);
    return 'error' in retry
      ? { kind: 'fail', message: retry.error }
      : { kind: 'retry', attempt: retry, reason: 'gpu-failed' };
  }

  if (options.target.mode === 'quality') return { kind: 'done' };
  const targetBytes = options.target.megabytes * BYTES_PER_MB;
  if (outcome.sizeBytes <= targetBytes) return { kind: 'done' };

  const overshoot = `salió de ${mb(outcome.sizeBytes)} MB y el máximo era ${mb(targetBytes)} MB`;
  // Un solo reintento por tamaño: si ya hubo uno, no se insiste.
  if (last || attempt.sizeRetried) {
    return {
      kind: 'fail',
      message: `No se llegó al tamaño pedido: ${overshoot}. Probá una resolución más baja o un tamaño mayor.`,
    };
  }
  if (attempt.videoKbps === null) {
    // Se probó con la calidad del preset porque el original entraba, y se pasó:
    // ahora sí, apuntando al tamaño.
    const sized = withEncoder(source, options, attempt.encoder, attempt.number + 1, true);
    return 'error' in sized
      ? { kind: 'fail', message: sized.error }
      : { kind: 'retry', attempt: sized, reason: 'too-big' };
  }
  const videoKbps = retryVideoKbps({
    previousVideoKbps: attempt.videoKbps,
    audioKbps: outputAudioKbps(source, options),
    actualBytes: outcome.sizeBytes,
    targetBytes,
  });
  const codec = COMPRESSION_PRESETS[options.preset].codec;
  if (videoKbps < minVideoKbps(outputVideo(source, options), codec)) {
    return {
      kind: 'fail',
      message: `No se llegó al tamaño pedido sin romper la imagen: ${overshoot}. Probá una resolución más baja o un tamaño mayor.`,
    };
  }
  return {
    kind: 'retry',
    attempt: { number: attempt.number + 1, encoder: attempt.encoder, videoKbps, sizeRetried: true },
    reason: 'too-big',
  };
}
