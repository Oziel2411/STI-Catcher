import { EDIT_MAX_SEGMENTS, EDIT_MIN_SEGMENT_SECONDS } from '@sti-catcher/shared';
import type { EditOutput, EditSegment } from '@sti-catcher/shared';

/**
 * Recortar y dividir (D-112). El video se parte en tramos con cortes; cada
 * tramo queda o se saca. Todo puro: la página solo guarda la lista.
 */
export type Piece = { start: number; end: number; keep: boolean };

/** Si no se sabe a cuántos cuadros va, se avanza como si fuera a 30. */
export const DEFAULT_FPS = 30;

export const initialPieces = (duration: number): Piece[] => [
  { start: 0, end: duration, keep: true },
];

const round = (t: number) => Math.round(t * 1000) / 1000;

/** El tramo que contiene `t` (el último si `t` es el final). */
export const pieceAt = (pieces: readonly Piece[], t: number): number => {
  const index = pieces.findIndex((p) => t >= p.start && t < p.end);
  return index === -1 ? pieces.length - 1 : index;
};

/**
 * Corta en `t`. No hace nada si quedaría un tramo de menos de medio segundo
 * (un corte encima de otro) o si ya se llegó al tope de tramos.
 */
export function cutAt(pieces: readonly Piece[], t: number): Piece[] {
  if (pieces.length >= EDIT_MAX_SEGMENTS) return [...pieces];
  const at = round(t);
  const index = pieceAt(pieces, at);
  const piece = pieces[index];
  if (
    piece === undefined ||
    at - piece.start < EDIT_MIN_SEGMENT_SECONDS ||
    piece.end - at < EDIT_MIN_SEGMENT_SECONDS
  ) {
    return [...pieces];
  }
  return [
    ...pieces.slice(0, index),
    { ...piece, end: at },
    { ...piece, start: at },
    ...pieces.slice(index + 1),
  ];
}

/** Índice del corte (borde entre el tramo i y el i+1) más cercano a `t`, o null si no hay. */
export function nearestCut(pieces: readonly Piece[], t: number): number | null {
  let best: number | null = null;
  for (let i = 0; i < pieces.length - 1; i++) {
    const edge = pieces[i]?.end ?? 0;
    const bestEdge = best === null ? Infinity : (pieces[best]?.end ?? 0);
    if (Math.abs(edge - t) < Math.abs(bestEdge - t)) best = i;
  }
  return best;
}

/** Saca el corte `index`: los dos tramos se juntan y el resultado queda si quedaba alguno. */
export function removeCut(pieces: readonly Piece[], index: number): Piece[] {
  const left = pieces[index];
  const right = pieces[index + 1];
  if (left === undefined || right === undefined) return [...pieces];
  return [
    ...pieces.slice(0, index),
    { start: left.start, end: right.end, keep: left.keep || right.keep },
    ...pieces.slice(index + 2),
  ];
}

/** Mueve el corte `index` a `t`, sin dejar tramos de menos de medio segundo. */
export function moveCut(pieces: readonly Piece[], index: number, t: number): Piece[] {
  const left = pieces[index];
  const right = pieces[index + 1];
  if (left === undefined || right === undefined) return [...pieces];
  const at = round(
    Math.min(
      Math.max(t, left.start + EDIT_MIN_SEGMENT_SECONDS),
      right.end - EDIT_MIN_SEGMENT_SECONDS,
    ),
  );
  return pieces.map((p, i) =>
    i === index ? { ...p, end: at } : i === index + 1 ? { ...p, start: at } : p,
  );
}

export const toggleKeep = (pieces: readonly Piece[], index: number): Piece[] =>
  pieces.map((p, i) => (i === index ? { ...p, keep: !p.keep } : p));

/** Tecla I: el video empieza acá (se saca todo lo de antes). */
export function startHere(pieces: readonly Piece[], t: number): Piece[] {
  const cut = cutAt(pieces, t);
  return cut.map((p) => (p.end <= round(t) ? { ...p, keep: false } : p));
}

/** Tecla O: el video termina acá (se saca todo lo de después). */
export function endHere(pieces: readonly Piece[], t: number): Piece[] {
  const cut = cutAt(pieces, t);
  return cut.map((p) => (p.start >= round(t) ? { ...p, keep: false } : p));
}

/**
 * Lo que se manda al server. Al unir, los tramos que quedan y son vecinos
 * van como uno solo (no hace falta unirlos); al dividir, cada uno es un archivo.
 */
export function segmentsFor(pieces: readonly Piece[], output: EditOutput): EditSegment[] {
  const segments: EditSegment[] = [];
  for (const piece of pieces) {
    if (!piece.keep) continue;
    const last = segments.at(-1);
    if (output === 'single' && last !== undefined && last.end === piece.start) {
      last.end = piece.end;
    } else {
      segments.push({ start: piece.start, end: piece.end });
    }
  }
  return segments;
}

export const keptDuration = (pieces: readonly Piece[]) =>
  pieces.reduce((sum, p) => sum + (p.keep ? p.end - p.start : 0), 0);

/** ¿Hay algo para hacer? Todo entero en un archivo es el mismo video. */
export function editProblem(pieces: readonly Piece[], output: EditOutput): string | null {
  const segments = segmentsFor(pieces, output);
  if (segments.length === 0) return 'Dejá al menos un tramo.';
  const whole = pieces.every((p) => p.keep);
  if (whole && (output === 'single' || pieces.length === 1)) {
    return 'Marcá un corte (tecla C) o sacá un tramo: así queda igual que el original.';
  }
  return null;
}

/** Tiempo dentro del video, sin pasarse de los bordes. */
export const clampTime = (t: number, duration: number) => Math.min(Math.max(t, 0), duration);

export type EditorKey =
  | { kind: 'toggle-play' }
  | { kind: 'seek'; seconds: number }
  | { kind: 'frame'; frames: number }
  | { kind: 'cut' }
  | { kind: 'start-here' }
  | { kind: 'end-here' }
  | { kind: 'remove-cut' };

/**
 * Teclas del editor (`event.key`). Flechas: 1 s (10 s con Shift); coma y
 * punto: un cuadro; C corta; I y O marcan inicio y fin; Supr saca el corte
 * más cercano.
 */
export function editorKey(key: string, shift: boolean): EditorKey | null {
  switch (key) {
    case ' ':
    case 'k':
    case 'K':
      return { kind: 'toggle-play' };
    case 'ArrowLeft':
      return { kind: 'seek', seconds: shift ? -10 : -1 };
    case 'ArrowRight':
      return { kind: 'seek', seconds: shift ? 10 : 1 };
    case ',':
      return { kind: 'frame', frames: -1 };
    case '.':
      return { kind: 'frame', frames: 1 };
    case 'c':
    case 'C':
      return { kind: 'cut' };
    case 'i':
    case 'I':
      return { kind: 'start-here' };
    case 'o':
    case 'O':
      return { kind: 'end-here' };
    case 'Delete':
    case 'Backspace':
      return { kind: 'remove-cut' };
    default:
      return null;
  }
}

/** «1:02,5» o «1:02:03,5»: minutos y segundos con décimas, para la línea de tiempo. */
export function formatTimecode(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const s = Math.floor(tenths / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = `${String(s % 60).padStart(2, '0')},${String(tenths % 10)}`;
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${rest}` : `${String(m)}:${rest}`;
}
