import { FFMPEG_BASE_ARGS } from '../../adapters/ffmpeg.ts';
import type { MediaInfo } from '../../adapters/ffprobe.ts';

export type RecordingPlan = {
  args: string[];
  /** copy: la captura ya era H.264 + AAC (solo se rearma el MP4); encode: se recodifica. */
  mode: 'copy' | 'encode';
};

/**
 * Normaliza una captura de MediaRecorder a MP4 H.264 + AAC (SPEC §6).
 *
 * - Si ya es H.264 (8 bits) + AAC (MP4 de Chrome): se remuxea. El MP4 de
 *   MediaRecorder es fragmentado; rearmarlo con +faststart deja un MP4
 *   común, con duración e índice al principio.
 * - Si no (WebM VP9/Opus): se recodifica. El WebM de MediaRecorder no trae
 *   duración ni índice de búsqueda (medido: duración N/A, sin Cues); el MP4
 *   resultante sí.
 *
 * Al recodificar:
 * - `-fps_mode cfr -r <fps>`: MediaRecorder graba con cuadros irregulares
 *   (solo cuando cambia la pantalla); a cuadros constantes la duración es
 *   exacta y cualquier editor lo abre.
 * - Ancho y alto pares: H.264 4:2:0 los exige, y una ventana capturada
 *   puede medir, por ejemplo, 1365×767.
 * - preset veryfast: una grabación puede durar horas; el contenido de
 *   pantalla comprime bien igual.
 * - El audio es opcional (`0:a:0?`): una grabación sin audio es válida.
 */
export function buildRecordingArgs(options: {
  inputPath: string;
  outputPath: string;
  media: MediaInfo;
  fps: number;
}): RecordingPlan {
  const { inputPath, outputPath, media, fps } = options;
  const maps = ['-map', '0:v:0', '-map', '0:a:0?'];
  const video = media.video;
  const canCopy =
    video !== null &&
    video.codec === 'h264' &&
    (video.pixFmt === null || video.pixFmt === 'yuv420p') &&
    (media.audio === null || media.audio.codec === 'aac');

  if (canCopy) {
    return {
      args: [
        ...FFMPEG_BASE_ARGS,
        '-i',
        inputPath,
        ...maps,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      mode: 'copy',
    };
  }
  return {
    args: [
      ...FFMPEG_BASE_ARGS,
      '-i',
      inputPath,
      ...maps,
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-fps_mode',
      'cfr',
      '-r',
      String(fps),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    mode: 'encode',
  };
}
