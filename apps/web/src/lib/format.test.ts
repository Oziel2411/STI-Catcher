import { describe, expect, it } from 'vitest';
import { formatBytes, formatEta, formatSpeedRatio, formatUptime } from './format.ts';

describe('formatEta', () => {
  it('usa la unidad más grande con dos dígitos en la menor', () => {
    expect(formatEta(0)).toBe('0 s');
    expect(formatEta(44.6)).toBe('45 s');
    expect(formatEta(65)).toBe('1 min 05 s');
    expect(formatEta(3720)).toBe('1 h 02 min');
  });

  it('devuelve un guion si no se conoce', () => {
    expect(formatEta(null)).toBe('—');
    expect(formatEta(-3)).toBe('—');
  });
});

describe('formatSpeedRatio', () => {
  it('redondea a un decimal con coma', () => {
    expect(formatSpeedRatio(1.013)).toBe('1x');
    expect(formatSpeedRatio(2.46)).toBe('2,5x');
    expect(formatSpeedRatio(null)).toBe('—');
  });
});

describe('formatBytes', () => {
  it('usa base 1024 y el formato de es-AR (punto de miles, coma decimal)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1.023 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB');
  });

  it('no pasa de TB', () => {
    expect(formatBytes(2048 * 1024 ** 4)).toBe('2.048 TB');
  });

  it('devuelve un guion para valores inválidos', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatUptime', () => {
  it('elige la unidad según el tamaño', () => {
    expect(formatUptime(42)).toBe('42 s');
    expect(formatUptime(125)).toBe('2 min');
    expect(formatUptime(3725)).toBe('1 h 2 min');
    expect(formatUptime(2 * 86_400 + 3 * 3600)).toBe('2 d 3 h');
  });
});
