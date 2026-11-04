import type { MailMessage, SendMail } from '../../adapters/mailer.ts';
import { MailError } from '../../adapters/mailer.ts';
import type { JobRecord } from '../../jobs/types.ts';

export type RecordingNoticeDeps = {
  send: SendMail;
  /** Destinatarios (MAIL_TO). Vacío: no se manda nada. */
  to: readonly string[];
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "04/11/2026 15:48", en la hora del servidor (la misma de la oficina). */
export function mailDateTime(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 3725 → "1:02:05"; 65 → "1:05". */
function duration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = pad(total % 60);
  return h > 0 ? `${String(h)}:${pad(m)}:${s}` : `${String(m)}:${s}`;
}

/** 5_983_232 → "5,7 MB". */
function size(bytes: number | null): string | null {
  if (bytes === null) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 ? String(value) : value.toFixed(1).replace('.', ',');
  return `${text} ${units[unit] ?? 'B'}`;
}

/** El mail de una grabación terminada (texto plano: se lee bien en cualquier cliente). */
export function recordingDoneMessage(record: JobRecord, to: readonly string[]): MailMessage {
  const title = record.title ?? 'Grabación de pantalla';
  const details: [string, string | null][] = [
    ['Duración', duration(record.durationSeconds)],
    ['Resolución', record.resolution],
    ['Tamaño', size(record.sizeBytes)],
    ['Pedida desde', record.clientHost ?? record.clientIp],
    ['Empezó', mailDateTime(record.createdAt)],
    ['Terminó', mailDateTime(record.finishedAt)],
  ];
  const lines = details
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, value]) => `${label}: ${value}`);
  return {
    to: [...to],
    subject: `Grabación terminada: ${title}`,
    text: [
      `La grabación «${title}» terminó y ya está en el Historial de STI-Catcher.`,
      '',
      ...lines,
      '',
      'Mensaje automático de STI-Catcher. No hace falta responder.',
    ].join('\n'),
  };
}

/**
 * Aviso por mail al terminar una grabación (D-099). Se engancha en `onDone`
 * de la cola y no la demora: el envío sigue en segundo plano. Si falla, queda
 * en el log (la grabación igual está en el Historial).
 */
export function createRecordingNotice(deps: RecordingNoticeDeps) {
  return (record: JobRecord): void => {
    if (record.type !== 'recording' || record.status !== 'done' || deps.to.length === 0) return;
    const message = recordingDoneMessage(record, deps.to);
    deps
      .send(message)
      .then(() => {
        deps.logger.info(
          { jobId: record.id, recipients: message.to.length },
          'Aviso de grabación enviado por mail',
        );
      })
      .catch((error: unknown) => {
        deps.logger.warn(
          {
            jobId: record.id,
            code: error instanceof MailError ? error.code : undefined,
            err: error instanceof MailError ? error.cause : error,
          },
          'No se pudo enviar el aviso de grabación por mail',
        );
      });
  };
}
