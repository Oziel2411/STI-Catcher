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

/** Tiempo restante: 45 → "45 s", 65 → "1 min 05 s", 3720 → "1 h 02 min". */
export function formatEta(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${String(hours)} h ${pad(minutes)} min`;
  if (minutes > 0) return `${String(minutes)} min ${pad(rest)} s`;
  return `${String(rest)} s`;
}

/** Duración de un video: 65 → "1:05", 3725 → "1:02:05". */
export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.round(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${s}` : `${String(m)}:${s}`;
}

/** Velocidad de ffmpeg relativa al tiempo real: 1.013 → "1,0x". */
export function formatSpeedRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio) || ratio < 0) return '—';
  return `${numberFormat(1).format(Math.round(ratio * 10) / 10)}x`;
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
