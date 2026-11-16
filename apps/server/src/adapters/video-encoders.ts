import type { CompressionCodec, ResolvedEncoders } from '@sti-catcher/shared';
import type { CommandRunner } from './process.ts';

/** Encoder de GPU que se prueba para cada códec. */
const GPU_ENCODERS: Record<CompressionCodec, string> = { h264: 'h264_qsv', hevc: 'hevc_qsv' };

/**
 * Codificación de prueba: medio segundo de video sintético, sin archivo de
 * salida. Se usa el mismo formato de píxel (`nv12`) y modo de calidad
 * (`-global_quality`) que la compresión real: con los valores por defecto,
 * `hevc_qsv` falla en una GPU que sí sabe codificar H.265 (D-108).
 */
export function buildEncoderProbeArgs(encoder: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30:duration=0.5',
    '-vf',
    'format=nv12',
    '-c:v',
    encoder,
    '-global_quality',
    '24',
    '-f',
    'null',
    '-',
  ];
}

export type EncoderDetectionLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

/**
 * Prueba de verdad si la GPU codifica cada códec. Que ffmpeg liste el encoder
 * no alcanza: solo dice que se compiló, no que la placa (o el driver, o la
 * cuenta del servicio) lo pueda usar. Si falla o tarda, se usa la CPU.
 */
export async function detectVideoEncoders(
  run: CommandRunner,
  ffmpegPath: string,
  logger: EncoderDetectionLogger,
): Promise<ResolvedEncoders> {
  const probe = async (codec: CompressionCodec) => {
    const encoder = GPU_ENCODERS[codec];
    try {
      const result = await run(ffmpegPath, buildEncoderProbeArgs(encoder), {
        timeoutMs: 20_000,
        maxOutputChars: 4096,
      });
      if (result.exitCode === 0 && !result.timedOut) return 'qsv' as const;
      logger.info(
        { encoder, exitCode: result.exitCode, stderr: result.stderr.trim().slice(0, 500) },
        'La GPU no codifica este códec: se comprime por CPU',
      );
    } catch (error) {
      logger.warn({ encoder, err: error }, 'No se pudo probar el encoder de GPU');
    }
    return 'cpu' as const;
  };
  // De a uno: dos pruebas a la vez sobre la misma GPU pueden fallar por recursos.
  const h264 = await probe('h264');
  const hevc = await probe('hevc');
  return { h264, hevc };
}

/**
 * Encoders resueltos al arrancar, con caída a CPU durante la vida del
 * proceso: si la GPU falla en un trabajo real, ese códec pasa a CPU para los
 * siguientes (el trabajo que falló se reintenta por CPU en el runner).
 */
export function createEncoderRegistry(detection: Promise<ResolvedEncoders>) {
  const fallen = new Set<CompressionCodec>();
  let known: ResolvedEncoders | null = null;
  const resolved = detection
    .catch((): ResolvedEncoders => ({ h264: 'cpu', hevc: 'cpu' }))
    .then((encoders) => {
      known = encoders;
      return encoders;
    });
  const withFallbacks = (encoders: ResolvedEncoders): ResolvedEncoders => ({
    h264: fallen.has('h264') ? 'cpu' : encoders.h264,
    hevc: fallen.has('hevc') ? 'cpu' : encoders.hevc,
  });
  return {
    /** Lo resuelto hasta ahora, sin esperar (para la página Estado); null mientras se prueba. */
    peek(): ResolvedEncoders | null {
      return known === null ? null : withFallbacks(known);
    },
    async current(): Promise<ResolvedEncoders> {
      return withFallbacks(await resolved);
    },
    markGpuFailed(codec: CompressionCodec): void {
      fallen.add(codec);
    },
  };
}

export type EncoderRegistry = ReturnType<typeof createEncoderRegistry>;
