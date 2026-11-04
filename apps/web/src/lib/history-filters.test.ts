import { describe, expect, it } from 'vitest';
import { dayRange, invalidRange } from './history-filters.ts';

describe('dayRange', () => {
  it('cubre los días completos en hora local', () => {
    const range = dayRange('2026-11-03', '2026-11-04');
    expect(range.from).toBe(new Date(2026, 10, 3).toISOString());
    expect(range.to).toBe(new Date(2026, 10, 5).toISOString());
  });

  it('cada extremo es opcional; lo que no es fecha se ignora', () => {
    expect(dayRange('2026-11-03', null)).toEqual({ from: new Date(2026, 10, 3).toISOString() });
    expect(dayRange(null, '2026-12-31')).toEqual({ to: new Date(2027, 0, 1).toISOString() });
    expect(dayRange('ayer', '')).toEqual({});
  });
});

it('invalidRange', () => {
  expect(invalidRange('2026-11-05', '2026-11-04')).toBe(true);
  expect(invalidRange('2026-11-04', '2026-11-04')).toBe(false);
  expect(invalidRange('2026-11-04', null)).toBe(false);
});
