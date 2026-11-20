import type { EditPrecision, EditSegment } from '@sti-catcher/shared';
import { FFMPEG_BASE_ARGS } from '../../adapters/ffmpeg.ts';
import type { MediaInfo } from '../../adapters/ffprobe.ts';

export type EditPlan = {
  args: string[];
  /** Duración del resultado (suma de los tramos), para el porcentaje. */
  totalDurationSeconds: number;
  /**
   * Lista para el demuxer concat (copiar varios tramos sin recodificar). El
   * runner la escribe en `concatListPath` antes de correr ffmpeg.
   */
  concatList: string | null;
};

/** Segundos con milisegundos, sin notación científica ni ceros de más. */
export const formatSeconds = (seconds: number): string =>
  String(Math.round(Math.max(0, seconds) * 1000) / 1000);

/** Comillas simples del formato ffconcat: `'` se escribe `'\''`. */
const quoteConcatPath = (filePath: string) => `'${filePath.replaceAll("'", "'\\''")}'`;

const VIDEO_ENCODE = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  // 18: a simple vista igual al original; el contenido de pantalla comprime bien.
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
];
const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '160k'];
const EVEN_SIZE = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
const MP4_OUT = ['-movflags', '+faststart'];

/**
 * Recortar y dividir (D-112): deja los tramos pedidos, unidos en un MP4.
 * Al dividir, cada parte es un job con un solo tramo.
 *
 * Exacto (recodifica, por defecto):
 * - Un tramo: `-ss` antes de `-i` busca rápido y, al recodificar, ffmpeg
 *   descarta los cuadros hasta el punto pedido: el corte cae en el cuadro.
 * - Varios: el mismo archivo abierto una vez por tramo (cada uno con su
 *   `-ss`/`-t`, así no se decodifica lo que se saca) y el filtro `concat`.
 * - H.264 + AAC en MP4, ancho y alto pares (como la grabación).
 *
 * Rápido (`-c copy`): sin recodificar no se puede empezar en un cuadro que
 * no sea clave, así que el tramo arranca en el clave anterior (puede quedar
 * unos segundos antes). Varios tramos van con el demuxer concat y
 * `inpoint`/`outpoint`.
 *
 * El audio es opcional en todos los casos.
 */
export function buildEditArgs(options: {
  inputPath: string;
  outputPath: string;
  /** Dónde va la lista del demuxer concat (solo rápido con varios tramos). */
  concatListPath: string;
  media: MediaInfo;
  segments: readonly EditSegment[];
  precision: EditPrecision;
}): EditPlan {
  const { inputPath, outputPath, concatListPath, media, segments, precision } = options;
  if (segments.length === 0) throw new Error('buildEditArgs necesita al menos un tramo');
  const totalDurationSeconds = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const hasAudio = media.audio !== null;
  const plan = (args: string[], concatList: string | null = null): EditPlan => ({
    args: [...FFMPEG_BASE_ARGS, ...args, ...MP4_OUT, outputPath],
    totalDurationSeconds,
    concatList,
  });
  const cut = (s: EditSegment) => [
    '-ss',
    formatSeconds(s.start),
    '-t',
    formatSeconds(s.end - s.start),
  ];
  const maps = ['-map', '0:v:0', '-map', '0:a:0?'];

  if (precision === 'fast') {
    const [only] = segments;
    if (segments.length === 1 && only !== undefined) {
      return plan([
        ...cut(only),
        '-i',
        inputPath,
        ...maps,
        '-c',
        'copy',
        // El tramo empieza en un cuadro clave anterior: que los tiempos arranquen en 0.
        '-avoid_negative_ts',
        'make_zero',
      ]);
    }
    const list = [
      'ffconcat version 1.0',
      ...segments.flatMap((s) => [
        `file ${quoteConcatPath(inputPath)}`,
        `inpoint ${formatSeconds(s.start)}`,
        `outpoint ${formatSeconds(s.end)}`,
      ]),
      '',
    ].join('\n');
    return plan(
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        ...maps,
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
      ],
      list,
    );
  }

  const [only] = segments;
  if (segments.length === 1 && only !== undefined) {
    return plan([
      ...cut(only),
      '-i',
      inputPath,
      ...maps,
      '-vf',
      EVEN_SIZE,
      ...VIDEO_ENCODE,
      ...AUDIO_ENCODE,
    ]);
  }

  const inputs = segments.flatMap((s) => [...cut(s), '-i', inputPath]);
  const streams = segments
    .map((_, i) => `[${String(i)}:v:0]${hasAudio ? `[${String(i)}:a:0]` : ''}`)
    .join('');
  const concat = `${streams}concat=n=${String(segments.length)}:v=1:a=${hasAudio ? '1' : '0'}`;
  const filter = `${concat}[vcat]${hasAudio ? '[a]' : ''};[vcat]${EVEN_SIZE}[v]`;
  return plan([
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    ...(hasAudio ? ['-map', '[a]'] : []),
    ...VIDEO_ENCODE,
    ...(hasAudio ? AUDIO_ENCODE : []),
  ]);
}
