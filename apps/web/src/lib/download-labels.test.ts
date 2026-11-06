import { expect, it } from 'vitest';
import { applyButtonLabel, rowName, startButtonLabel } from './download-batch.ts';

it('startButtonLabel no muestra «0 listos»', () => {
  expect(startButtonLabel(0, false)).toBe('Descargar');
  expect(startButtonLabel(1, false)).toBe('Descargar 1 listo');
  expect(startButtonLabel(3, false)).toBe('Descargar 3 listos');
  expect(startButtonLabel(3, true)).toBe('Creando…');
});

it('applyButtonLabel no muestra «a 0»', () => {
  expect(applyButtonLabel(0)).toBe('Aplicar');
  expect(applyButtonLabel(2)).toBe('Aplicar a 2');
});

it('rowName: el título, o el link si todavía no se analizó', () => {
  expect(rowName({ url: 'https://x.test/v', probe: null })).toBe('https://x.test/v');
});
