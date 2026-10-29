import { RECORDING_MIME_CANDIDATES } from '@sti-catcher/shared';

/** El primer formato que soporta el navegador, en el orden del SPEC §6. */
export function pickMimeType(isTypeSupported: (type: string) => boolean): string | null {
  return RECORDING_MIME_CANDIDATES.find((type) => isTypeSupported(type)) ?? null;
}

export type RecordingSupport =
  | { ok: true }
  | { ok: false; reason: 'insecure'; origin: string }
  | { ok: false; reason: 'unsupported' };

/**
 * ¿Se puede grabar? `getDisplayMedia` solo existe en un contexto seguro
 * (HTTPS, o http://localhost). Desde otra PC por http://<IP> no existe: hay
 * que explicarlo en vez de fallar en silencio (SPEC §6).
 */
export function recordingSupport(env: {
  isSecureContext: boolean;
  hasGetDisplayMedia: boolean;
  hasMediaRecorder: boolean;
  origin: string;
}): RecordingSupport {
  if (!env.isSecureContext) return { ok: false, reason: 'insecure', origin: env.origin };
  if (!env.hasGetDisplayMedia || !env.hasMediaRecorder) return { ok: false, reason: 'unsupported' };
  return { ok: true };
}

const titleFormat = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' });

/** "Grabación de pantalla 29/10/26, 15:40" (hora de la PC de quien graba). */
export const defaultRecordingTitle = (date: Date) =>
  `Grabación de pantalla ${titleFormat.format(date)}`;
