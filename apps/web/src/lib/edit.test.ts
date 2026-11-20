import { describe, expect, it } from 'vitest';
import {
  cutAt,
  editorKey,
  editProblem,
  endHere,
  formatTimecode,
  initialPieces,
  keptDuration,
  moveCut,
  nearestCut,
  removeCut,
  segmentsFor,
  startHere,
  toggleKeep,
} from './edit.ts';
import type { Piece } from './edit.ts';

const sixty = initialPieces(60);

describe('cortes', () => {
  it('cortar parte el tramo en dos que quedan', () => {
    expect(cutAt(sixty, 20)).toEqual([
      { start: 0, end: 20, keep: true },
      { start: 20, end: 60, keep: true },
    ]);
  });

  it('un corte pegado a otro o al borde no hace nada', () => {
    const once = cutAt(sixty, 20);
    expect(cutAt(once, 20.2)).toEqual(once);
    expect(cutAt(sixty, 0.1)).toEqual(sixty);
    expect(cutAt(sixty, 59.8)).toEqual(sixty);
  });

  it('el corte se redondea a milisegundos', () => {
    expect(cutAt(sixty, 10.123456)[0]?.end).toBe(10.123);
  });

  it('no pasa de 20 tramos', () => {
    let pieces: Piece[] = sixty;
    for (let t = 1; t < 60; t++) pieces = cutAt(pieces, t);
    expect(pieces).toHaveLength(20);
  });

  it('sacar un corte junta los tramos; queda si quedaba alguno', () => {
    const pieces = toggleKeep(cutAt(cutAt(sixty, 20), 40), 1);
    expect(nearestCut(pieces, 38)).toBe(1);
    expect(removeCut(pieces, 1)).toEqual([
      { start: 0, end: 20, keep: true },
      { start: 20, end: 60, keep: true },
    ]);
    expect(nearestCut(sixty, 10)).toBeNull();
  });

  it('mover un corte no deja tramos de menos de medio segundo', () => {
    const pieces = cutAt(cutAt(sixty, 20), 40);
    expect(moveCut(pieces, 0, 39.9)[0]?.end).toBe(39.5);
    expect(moveCut(pieces, 0, -5)[1]?.start).toBe(0.5);
    expect(moveCut(pieces, 1, 45)[2]).toEqual({ start: 45, end: 60, keep: true });
  });
});

describe('recortes de siempre', () => {
  it('sacar el principio y el final (I y O): un solo tramo', () => {
    const pieces = endHere(startHere(sixty, 5), 50);
    expect(segmentsFor(pieces, 'single')).toEqual([{ start: 5, end: 50 }]);
    expect(keptDuration(pieces)).toBe(45);
  });

  it('sacar un tramo del medio: dos tramos que se unen en un archivo', () => {
    const pieces = toggleKeep(cutAt(cutAt(sixty, 20), 30), 1);
    expect(segmentsFor(pieces, 'single')).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 60 },
    ]);
  });

  it('dividir: cada tramo que queda es un archivo, aunque sean vecinos', () => {
    const pieces = cutAt(cutAt(sixty, 20), 40);
    expect(segmentsFor(pieces, 'split')).toHaveLength(3);
    // Al unir, los vecinos van juntos: es el video entero.
    expect(segmentsFor(pieces, 'single')).toEqual([{ start: 0, end: 60 }]);
  });
});

describe('editProblem', () => {
  it('sin cambios no hay nada que hacer', () => {
    expect(editProblem(sixty, 'single')).not.toBeNull();
    expect(editProblem(sixty, 'split')).not.toBeNull();
    expect(editProblem(cutAt(sixty, 20), 'single')).not.toBeNull();
  });

  it('con un corte se puede dividir; sacando todo, no', () => {
    expect(editProblem(cutAt(sixty, 20), 'split')).toBeNull();
    expect(editProblem(toggleKeep(sixty, 0), 'single')).toBe('Dejá al menos un tramo.');
  });
});

describe('editorKey', () => {
  it('flechas, coma y punto, y las letras', () => {
    expect(editorKey('ArrowLeft', false)).toEqual({ kind: 'seek', seconds: -1 });
    expect(editorKey('ArrowRight', true)).toEqual({ kind: 'seek', seconds: 10 });
    expect(editorKey('.', false)).toEqual({ kind: 'frame', frames: 1 });
    expect(editorKey(',', false)).toEqual({ kind: 'frame', frames: -1 });
    expect(editorKey('C', false)).toEqual({ kind: 'cut' });
    expect(editorKey('i', false)).toEqual({ kind: 'start-here' });
    expect(editorKey('o', false)).toEqual({ kind: 'end-here' });
    expect(editorKey(' ', false)).toEqual({ kind: 'toggle-play' });
    expect(editorKey('Delete', false)).toEqual({ kind: 'remove-cut' });
    expect(editorKey('x', false)).toBeNull();
  });
});

describe('formatTimecode', () => {
  it('minutos y segundos con décimas; horas si hace falta', () => {
    expect(formatTimecode(0)).toBe('0:00,0');
    expect(formatTimecode(62.46)).toBe('1:02,5');
    expect(formatTimecode(3723.04)).toBe('1:02:03,0');
  });
});
