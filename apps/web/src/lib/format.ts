const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

const numberFormat = (fractionDigits: number) =>
  new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });

/** 1536 → "1,5 KB". Usa base 1024, como el Explorador de Windows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${numberFormat(unit === 0 ? 0 : 1).format(value)} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/** 3725 → "1 h 2 min". Para tiempos de actividad y duraciones largas. */
export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}
