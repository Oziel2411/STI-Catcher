import { describe, expect, it } from 'vitest';
import { formatBytes, formatUptime } from './format.ts';

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
