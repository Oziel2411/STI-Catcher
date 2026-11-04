import type { JobType } from '@sti-catcher/shared';

/** Opciones del filtro "Origen" (D-098). */
export const ORIGIN_OPTIONS: { value: JobType; label: string }[] = [
  { value: 'download', label: 'Descargas' },
  { value: 'upload', label: 'Archivos subidos' },
  { value: 'conversion', label: 'Conversiones' },
  { value: 'recording', label: 'Grabaciones' },
];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-04" (input type=date) → medianoche local de ese día, o null si no es una fecha. */
function localMidnight(value: string | null, addDays = 0): Date | null {
  const match = value ? DAY.exec(value) : null;
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + addDays);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Días elegidos (hora local de quien mira) → rango para el server, en ISO:
 * desde el inicio de "desde" hasta el final de "hasta" (inclusive).
 */
export function dayRange(from: string | null, to: string | null): { from?: string; to?: string } {
  const start = localMidnight(from);
  const end = localMidnight(to, 1);
  return {
    ...(start ? { from: start.toISOString() } : {}),
    ...(end ? { to: end.toISOString() } : {}),
  };
}

/** "Desde" posterior a "hasta": no puede haber resultados. */
export function invalidRange(from: string | null, to: string | null): boolean {
  const start = localMidnight(from);
  const end = localMidnight(to);
  return start !== null && end !== null && start.getTime() > end.getTime();
}
