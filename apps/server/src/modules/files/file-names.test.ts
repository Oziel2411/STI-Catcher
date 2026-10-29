import { describe, expect, it } from 'vitest';
import { buildDownloadFileName } from './file-names.ts';

describe('buildDownloadFileName', () => {
  it('conserva tildes, ñ y emojis', () => {
    expect(buildDownloadFileName('Canción del ñandú 🎵', 'mp4')).toBe('Canción del ñandú 🎵.mp4');
  });

  it('reemplaza los caracteres prohibidos en Windows', () => {
    expect(buildDownloadFileName('AC/DC: "Live" <2026> | ¿Qué? *', 'mp3')).toBe(
      'AC DC Live 2026 ¿Qué.mp3',
    );
  });

  it('no deja barras ni ".." que armen una ruta', () => {
    expect(buildDownloadFileName('..\\..\\Windows\\win.ini', 'mp4')).toBe('Windows win.ini.mp4');
  });

  it('quita caracteres de control y saltos de línea', () => {
    expect(buildDownloadFileName('línea 1\nlínea 2\u0000', 'mp4')).toBe('línea 1 línea 2.mp4');
  });

  it('evita nombres reservados de Windows', () => {
    expect(buildDownloadFileName('CON', 'mp4')).toBe('_CON.mp4');
    expect(buildDownloadFileName('nul', 'mp3')).toBe('_nul.mp3');
    expect(buildDownloadFileName('Console', 'mp4')).toBe('Console.mp4');
  });

  it('sin título usa "archivo"', () => {
    expect(buildDownloadFileName(null, 'mp4')).toBe('archivo.mp4');
    expect(buildDownloadFileName('  ...  ', '.M4A')).toBe('archivo.m4a');
  });

  it('acorta títulos largos sin partir un emoji', () => {
    const name = buildDownloadFileName(`${'a'.repeat(149)}😀😀😀`, 'mp4');
    expect(name).toBe(`${'a'.repeat(149)}😀.mp4`);
  });

  it('normaliza a NFC (tildes compuestas de macOS/iOS)', () => {
    const decomposed = 'Canción';
    expect(buildDownloadFileName(decomposed, 'mp4')).toBe('Canción.mp4');
  });
});
