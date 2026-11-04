import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  describeSchedule,
  formatCountdown,
  formatSpan,
  nextOccurrence,
  parseClock,
  plannedStart,
  plannedStop,
  scheduleProblems,
} from './recording-schedule.ts';
import type { RecordingSchedule } from './recording-schedule.ts';

/** 4/11/2026 10:30 hora local. */
const now = new Date(2026, 10, 4, 10, 30, 0);
const at = (h: number, m: number, dayOffset = 0) =>
  new Date(2026, 10, 4 + dayOffset, h, m, 0).getTime();
const schedule = (patch: Partial<RecordingSchedule>): RecordingSchedule => ({
  ...DEFAULT_SCHEDULE,
  ...patch,
});

describe('parseClock / nextOccurrence', () => {
  it('lee HH:MM y rechaza lo demás', () => {
    expect(parseClock('14:05')).toEqual([14, 5]);
    expect(parseClock(' 08:00 ')).toEqual([8, 0]);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('8:00')).toBeNull();
    expect(parseClock('')).toBeNull();
  });

  it('hoy si todavía no pasó; mañana si ya pasó (o es justo ahora)', () => {
    expect(nextOccurrence('14:00', now)?.getTime()).toBe(at(14, 0));
    expect(nextOccurrence('08:00', now)?.getTime()).toBe(at(8, 0, 1));
    expect(nextOccurrence('10:30', now)?.getTime()).toBe(at(10, 30, 1));
  });
});

describe('plannedStart / plannedStop', () => {
  it('inicio: ahora o a la hora indicada', () => {
    expect(plannedStart(schedule({}), now)).toBeNull();
    expect(plannedStart(schedule({ startMode: 'at', startAt: '14:00' }), now)).toBe(at(14, 0));
  });

  it('corte: a mano, después de N minutos o a una hora posterior al inicio', () => {
    const start = at(14, 0);
    expect(plannedStop(schedule({}), start)).toBeNull();
    expect(plannedStop(schedule({ stopMode: 'after', stopAfterMinutes: 90 }), start)).toBe(
      at(15, 30),
    );
    expect(plannedStop(schedule({ stopMode: 'at', stopAt: '16:15' }), start)).toBe(at(16, 15));
    // Cruza la medianoche: de 23:00 a 01:00.
    expect(plannedStop(schedule({ stopMode: 'at', stopAt: '01:00' }), at(23, 0))).toBe(at(1, 0, 1));
  });
});

describe('scheduleProblems', () => {
  it('pide las horas y una duración válida', () => {
    expect(scheduleProblems(schedule({ startMode: 'at' }), now)).toEqual([
      'Indicá a qué hora empieza.',
    ]);
    expect(scheduleProblems(schedule({ stopMode: 'at' }), now)).toEqual([
      'Indicá a qué hora termina.',
    ]);
    expect(
      scheduleProblems(schedule({ stopMode: 'after', stopAfterMinutes: 0 }), now),
    ).toHaveLength(1);
    expect(
      scheduleProblems(schedule({ stopMode: 'after', stopAfterMinutes: 2.5 }), now),
    ).toHaveLength(1);
    expect(scheduleProblems(schedule({ stopMode: 'after', stopAfterMinutes: 45 }), now)).toEqual(
      [],
    );
  });

  it('acepta un corte a la misma hora del inicio (es al día siguiente, justo el máximo)', () => {
    const same = schedule({ startMode: 'at', startAt: '14:00', stopMode: 'at', stopAt: '14:00' });
    expect(scheduleProblems(same, now)).toEqual([]);
    expect(plannedStop(same, at(14, 0))).toBe(at(14, 0, 1));
  });
});

describe('describeSchedule', () => {
  it('nada programado: sin texto', () => {
    expect(describeSchedule(schedule({}), now)).toBeNull();
  });

  it('inicio y fin a una hora', () => {
    expect(
      describeSchedule(
        schedule({ startMode: 'at', startAt: '14:00', stopMode: 'at', stopAt: '15:30' }),
        now,
      ),
    ).toBe('Empieza hoy a las 14:00 y termina hoy a las 15:30 (1 h 30 min).');
  });

  it('inicio mañana y duración fija', () => {
    expect(
      describeSchedule(
        schedule({ startMode: 'at', startAt: '08:00', stopMode: 'after', stopAfterMinutes: 45 }),
        now,
      ),
    ).toBe('Empieza mañana a las 08:00 y dura 45 min.');
  });

  it('solo corte', () => {
    expect(describeSchedule(schedule({ stopMode: 'after', stopAfterMinutes: 120 }), now)).toBe(
      'Empieza al tocar «Empezar a grabar» y dura 2 h.',
    );
  });
});

it('formatos de tiempo', () => {
  expect(formatSpan(90)).toBe('2 min');
  expect(formatSpan(5400)).toBe('1 h 30 min');
  expect(formatCountdown(65)).toBe('1:05');
  expect(formatCountdown(3725)).toBe('1:02:05');
  expect(formatCountdown(-3)).toBe('0:00');
});
