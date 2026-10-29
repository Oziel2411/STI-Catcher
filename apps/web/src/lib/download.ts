import type {
  ProbeResponse,
  ResolutionOption,
  VideoCodecFamily,
  VideoMode,
} from '@sti-catcher/shared';

const CODEC_LABELS: Record<VideoCodecFamily, string> = {
  h264: 'H.264',
  h265: 'H.265',
  vp9: 'VP9',
  av1: 'AV1',
  other: 'otro codec',
};

/** ['vp9', 'av1'] → "VP9/AV1" */
export const codecsLabel = (codecs: readonly VideoCodecFamily[]) =>
  codecs.map((codec) => CODEC_LABELS[codec]).join('/');

/** Texto de cada opción de resolución. Aclara cuando no hay H.264. */
export function resolutionLabel(option: ResolutionOption): string {
  const base = `${String(option.height)}p`;
  return option.codecs.includes('h264') ? base : `${base} · solo ${codecsLabel(option.codecs)}`;
}

/**
 * Resolución elegida por defecto: la mayor en H.264, como mucho 1080p (4K
 * pesa varias veces más y casi nadie lo necesita). null = "la mejor disponible"
 * (sitios que no informan resoluciones).
 */
export function defaultHeight(probe: ProbeResponse): number | null {
  const options = probe.resolutions;
  if (options.length === 0) return null;
  const target = Math.min(1080, probe.maxH264Height ?? options[0]?.height ?? 1080);
  return options.find((r) => r.height <= target)?.height ?? options.at(-1)?.height ?? null;
}

/**
 * Modo por defecto: compatibilidad máxima (SPEC §5). Si el video no existe
 * en H.264 en ninguna resolución, ese modo no puede cumplir: se propone recodificar.
 */
export function defaultMode(probe: ProbeResponse): VideoMode {
  return probe.hasVideo && probe.maxH264Height === null ? 'recode' : 'compat';
}

export type CodecNotice =
  /** compat con una resolución que no está en H.264: se va a bajar menos resolución. */
  | { kind: 'compat-downgrade'; requested: number; h264Height: number; codecs: VideoCodecFamily[] }
  /** compat sin ninguna H.264 a esa resolución o menor. */
  | { kind: 'compat-impossible'; requested: number | null }
  /** quality: el MP4 va a quedar en el codec original, que no es H.264. */
  | { kind: 'quality-codec'; codecs: VideoCodecFamily[] }
  /** recode: lento y pesado para el servidor. */
  | { kind: 'recode-slow' };

/** Avisos sobre el codec del resultado, según el análisis y lo elegido (SPEC §5). */
export function codecNotices(
  probe: ProbeResponse,
  height: number | null,
  mode: VideoMode,
): CodecNotice[] {
  if (!probe.hasVideo) return [];
  if (mode === 'recode') return [{ kind: 'recode-slow' }];

  const requested = height ?? probe.resolutions[0]?.height ?? null;
  const option = probe.resolutions.find((r) => r.height === requested);

  if (mode === 'quality') {
    return option && !option.codecs.includes('h264')
      ? [{ kind: 'quality-codec', codecs: option.codecs }]
      : [];
  }

  // compat
  if (requested === null) {
    return probe.maxH264Height === null ? [{ kind: 'compat-impossible', requested: null }] : [];
  }
  if (option?.codecs.includes('h264')) return [];
  const h264Height = probe.resolutions.find(
    (r) => r.height <= requested && r.codecs.includes('h264'),
  )?.height;
  if (h264Height === undefined) return [{ kind: 'compat-impossible', requested }];
  return [
    {
      kind: 'compat-downgrade',
      requested,
      h264Height,
      codecs: option?.codecs ?? [],
    },
  ];
}
