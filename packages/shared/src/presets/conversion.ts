import { z } from 'zod';

/**
 * Presets de conversión (SPEC §7): lista cerrada. El usuario elige uno; los
 * argumentos de ffmpeg los arma el server a partir del preset, nunca a partir
 * de texto del cliente.
 */
export const CONVERSION_PRESET_IDS = [
  'mp4',
  'webm',
  'mkv',
  'mov',
  'avi',
  'gif',
  'mp3',
  'm4a',
  'wav',
] as const;
export const conversionPresetIdSchema = z.enum(CONVERSION_PRESET_IDS);
export type ConversionPresetId = z.infer<typeof conversionPresetIdSchema>;

/** Qué necesita el archivo de origen: video (salidas de video y GIF) o audio. */
export type PresetInput = 'video' | 'audio';

export type ConversionPreset = {
  id: ConversionPresetId;
  label: string;
  /** Para qué sirve, en palabras del usuario. */
  description: string;
  extension: string;
  needs: PresetInput;
  /** Si acepta "escalar la resolución" (los de video; el GIF tiene su propio ancho). */
  scalable: boolean;
};

export const CONVERSION_PRESETS: Record<ConversionPresetId, ConversionPreset> = {
  mp4: {
    id: 'mp4',
    label: 'MP4 (H.264 + AAC)',
    description: 'El más compatible: abre en cualquier reproductor, editor o celular.',
    extension: 'mp4',
    needs: 'video',
    scalable: true,
  },
  webm: {
    id: 'webm',
    label: 'WebM (VP9 + Opus)',
    description: 'Para la web. Archivos chicos; conversión lenta.',
    extension: 'webm',
    needs: 'video',
    scalable: true,
  },
  mkv: {
    id: 'mkv',
    label: 'MKV',
    description: 'Cambia solo el contenedor, sin perder calidad (si no se escala). Muy rápido.',
    extension: 'mkv',
    needs: 'video',
    scalable: true,
  },
  mov: {
    id: 'mov',
    label: 'MOV (H.264 + AAC)',
    description: 'Para editores de video (Premiere, Final Cut, DaVinci).',
    extension: 'mov',
    needs: 'video',
    scalable: true,
  },
  avi: {
    id: 'avi',
    label: 'AVI (MPEG-4 + MP3)',
    description: 'Para reproductores y equipos viejos que no abren MP4.',
    extension: 'avi',
    needs: 'video',
    scalable: true,
  },
  gif: {
    id: 'gif',
    label: 'GIF animado',
    description: 'Un fragmento corto, sin sonido. Elegís inicio, fin, cuadros por segundo y ancho.',
    extension: 'gif',
    needs: 'video',
    scalable: false,
  },
  mp3: {
    id: 'mp3',
    label: 'MP3',
    description: 'Solo el audio. Abre en cualquier lado.',
    extension: 'mp3',
    needs: 'audio',
    scalable: false,
  },
  m4a: {
    id: 'm4a',
    label: 'M4A (AAC)',
    description: 'Solo el audio, mejor calidad que MP3 al mismo tamaño.',
    extension: 'm4a',
    needs: 'audio',
    scalable: false,
  },
  wav: {
    id: 'wav',
    label: 'WAV',
    description: 'Solo el audio, sin comprimir. Para edición de sonido; archivos grandes.',
    extension: 'wav',
    needs: 'audio',
    scalable: false,
  },
};

/**
 * Presets válidos para un archivo (SPEC §7): un archivo de solo audio no
 * ofrece salidas de video, y uno sin audio no ofrece salidas de audio.
 */
export function availablePresets(media: {
  hasVideo: boolean;
  hasAudio: boolean;
}): ConversionPresetId[] {
  return CONVERSION_PRESET_IDS.filter((id) => {
    const needs = CONVERSION_PRESETS[id].needs;
    return needs === 'video' ? media.hasVideo : media.hasAudio;
  });
}

/** Alturas que se ofrecen para escalar (solo hacia abajo). */
export const SCALE_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240] as const;
