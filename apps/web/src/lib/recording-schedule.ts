/**
 * Programación de la grabación (D-097): empezar a una hora y cortar después
 * de N minutos o a una hora. Funciones puras: reciben "ahora" para poder
 * probarlas.
 */

export type StartMode = 'now' | 'at';
export type StopMode = 'manual' | 'after' | 'at';

export type RecordingSchedule = {
  startMode: StartMode;
  /** "HH:MM" (input type=time). */
  startAt: string;
  stopMode: StopMode;
  stopAfterMinutes: number;
  /** "HH:MM". */
  stopAt: string;
};

export const DEFAULT_SCHEDULE: RecordingSchedule = {
  startMode: 'now',
  startAt: '',
  stopMode: 'manual',
  stopAfterMinutes: 60,
  stopAt: '',
};

/** Tope de una grabación programada: un día. */
export const MAX_SCHEDULE_MINUTES = 24 * 60;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "14:05" → [14, 5]; null si no es una hora válida. */
export function parseClock(value: string): [number, number] | null {
  const match = TIME.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

/**
 * La próxima vez que el reloj marca esa hora después de `from` (hoy, o
 * mañana si ya pasó). Siempre en el futuro: "a las 8:00" a las 23:00 es mañana.
 */
export function nextOccurrence(clock: string, from: Date): Date | null {
  const parsed = parseClock(clock);
  if (!parsed) return null;
  const next = new Date(from);
  next.setHours(parsed[0], parsed[1], 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** Cuándo empieza (en ms). null = al tocar el botón. */
export function plannedStart(schedule: RecordingSchedule, now: Date): number | null {
  if (schedule.startMode === 'now') return null;
  return nextOccurrence(schedule.startAt, now)?.getTime() ?? null;
}

/** Cuándo corta una grabación que empezó en `startedAt`. null = al detener a mano. */
export function plannedStop(schedule: RecordingSchedule, startedAt: number): number | null {
  if (schedule.stopMode === 'after') return startedAt + schedule.stopAfterMinutes * 60_000;
  if (schedule.stopMode === 'at') {
    return nextOccurrence(schedule.stopAt, new Date(startedAt))?.getTime() ?? null;
  }
  return null;
}

/** Qué impide programar, en español (vacío si está todo bien). */
export function scheduleProblems(schedule: RecordingSchedule, now: Date): string[] {
  const problems: string[] = [];
  if (schedule.startMode === 'at' && !parseClock(schedule.startAt)) {
    problems.push('Indicá a qué hora empieza.');
  }
  if (schedule.stopMode === 'at' && !parseClock(schedule.stopAt)) {
    problems.push('Indicá a qué hora termina.');
  }
  if (
    schedule.stopMode === 'after' &&
    !(
      Number.isInteger(schedule.stopAfterMinutes) &&
      schedule.stopAfterMinutes >= 1 &&
      schedule.stopAfterMinutes <= MAX_SCHEDULE_MINUTES
    )
  ) {
    problems.push(`La duración tiene que ser de 1 a ${String(MAX_SCHEDULE_MINUTES)} minutos.`);
  }
  if (problems.length > 0) return problems;

  const start = plannedStart(schedule, now) ?? now.getTime();
  const stop = plannedStop(schedule, start);
  if (stop !== null && schedule.stopMode === 'at' && stop - start > MAX_SCHEDULE_MINUTES * 60_000) {
    problems.push('La grabación no puede durar más de un día.');
  }
  return problems;
}

/** "14:05", siempre en 24 h (el formato del navegador puede usar a. m./p. m.). */
export const formatClock = (ms: number) => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** "hoy a las 14:00" / "mañana a las 08:00". */
export function describeTime(ms: number, now: Date): string {
  const target = new Date(ms);
  const sameDay = target.toDateString() === now.toDateString();
  return `${sameDay ? 'hoy' : 'mañana'} a las ${formatClock(ms)}`;
}

/** 5400 s → "1 h 30 min"; 90 s → "2 min" (redondea hacia arriba los minutos). */
export function formatSpan(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${String(m)} min`;
  return m === 0 ? `${String(h)} h` : `${String(h)} h ${String(m)} min`;
}

/** Resumen de lo programado, para mostrar antes de confirmar. null si no hay nada programado. */
export function describeSchedule(schedule: RecordingSchedule, now: Date): string | null {
  if (schedule.startMode === 'now' && schedule.stopMode === 'manual') return null;
  if (scheduleProblems(schedule, now).length > 0) return null;
  const start = plannedStart(schedule, now);
  const startText =
    start === null ? 'Empieza al tocar «Empezar a grabar»' : `Empieza ${describeTime(start, now)}`;
  const stop = plannedStop(schedule, start ?? now.getTime());
  if (stop === null) return `${startText} y sigue hasta que la detengas.`;
  const length = formatSpan((stop - (start ?? now.getTime())) / 1000);
  const stopText =
    schedule.stopMode === 'after'
      ? `dura ${length}`
      : `termina ${describeTime(stop, now)} (${length})`;
  return `${startText} y ${stopText}.`;
}

/** Cuenta regresiva: 3725 s → "1:02:05". */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${s}` : `${String(m)}:${s}`;
}
