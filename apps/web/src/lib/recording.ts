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

/** Qué se comparte: los valores de `displaySurface` de getDisplayMedia. */
export type SourceKind = 'monitor' | 'window' | 'browser';

export const SOURCE_KINDS: readonly { kind: SourceKind; title: string; hint: string }[] = [
  { kind: 'monitor', title: 'Pantalla completa', hint: 'Todo lo que se ve' },
  { kind: 'window', title: 'Ventana', hint: 'Un solo programa' },
  { kind: 'browser', title: 'Pestaña', hint: 'Con su sonido' },
];

export const sourceTitle = (kind: SourceKind) =>
  SOURCE_KINDS.find((source) => source.kind === kind)?.title ?? 'Pantalla';

/** Lo que el usuario eligió de verdad (`track.getSettings().displaySurface`). */
export function sourceKindFromSurface(surface: unknown): SourceKind | null {
  return surface === 'monitor' || surface === 'window' || surface === 'browser' ? surface : null;
}

/**
 * Nombre legible de la pista. Chrome a veces da el título de la ventana y a
 * veces un identificador interno ("screen:0:0", "window:1234:0",
 * "web-contents-media-stream://…"): esos no se muestran.
 */
export function friendlyTrackLabel(label: string): string | null {
  const trimmed = label.trim();
  if (trimmed === '') return null;
  if (/^(screen|window|web-contents-media-stream):/i.test(trimmed)) return null;
  return trimmed;
}

/** Texto de la barra de la vista previa: "Ventana · Excel" / "1600x900 · con sonido". */
export function describeSource(source: {
  kind: SourceKind;
  label: string;
  width: number | undefined;
  height: number | undefined;
  hasAudio: boolean;
}): { title: string; meta: string } {
  const label = friendlyTrackLabel(source.label);
  const title = label ? `${sourceTitle(source.kind)} · ${label}` : sourceTitle(source.kind);
  const size =
    source.width && source.height ? `${String(source.width)}x${String(source.height)}` : null;
  const meta = [size, source.hasAudio ? 'con sonido' : 'sin sonido']
    .filter((part): part is string => part !== null)
    .join(' · ');
  return { title, meta };
}

/**
 * Opciones de getDisplayMedia. `displaySurface` es una sugerencia: Chrome y
 * Edge abren el selector en esa solapa; Firefox la ignora. Las opciones extra
 * no están en todos los navegadores (ni en los tipos de TypeScript): las que
 * no conoce, el navegador las ignora.
 */
export function displayMediaOptions(kind: SourceKind, fps: number, systemAudio: boolean) {
  return {
    video: { displaySurface: kind, frameRate: { ideal: fps } },
    audio: systemAudio,
    // No ofrecer la pestaña de STI-Catcher (grabarse a sí misma no sirve).
    selfBrowserSurface: 'exclude',
    // Chrome: botón "Compartir esta pestaña" para cambiar de pestaña sin cortar.
    surfaceSwitching: 'include',
    systemAudio: systemAudio ? 'include' : 'exclude',
    monitorTypeSurfaces: 'include',
  } as DisplayMediaStreamOptions;
}

/** Nivel del micrófono (0 a 1) a partir de muestras de -1 a 1 (RMS, con ganancia para la voz). */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  // La voz normal anda por 0,05–0,2 de RMS: ×4 la deja en la mitad de la barra.
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}
