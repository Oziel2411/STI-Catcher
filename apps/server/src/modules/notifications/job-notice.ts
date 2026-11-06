import { downloadParamsSchema } from '../download/download-runner.ts';
import type { MailMessage, SendMail } from '../../adapters/mailer.ts';
import { MailError } from '../../adapters/mailer.ts';
import type { JobRecord } from '../../jobs/types.ts';

/** Una cuenta a la que se le manda el aviso. */
export type NoticeRecipient = { email: string; name: string };

export type JobNoticeDeps = {
  send: SendMail;
  /** Mail y nombre de las cuentas **activas** de esa lista (las demás se saltean). */
  recipients: (userIds: readonly string[]) => NoticeRecipient[];
  /** Nombre de la cuenta que pidió el trabajo. */
  userName: (userId: string) => string | null;
  /** Dirección pública (PUBLIC_URL): si está, el mail lleva el link al Historial. */
  publicUrl: string | null;
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

/** Qué tipos avisan (D-104). Las subidas son instantáneas y el selftest es una prueba. */
const KINDS = {
  recording: { noun: 'La grabación', done: 'Grabación terminada', failed: 'Falló la grabación' },
  download: { noun: 'La descarga', done: 'Descarga terminada', failed: 'Falló la descarga' },
  conversion: {
    noun: 'La conversión',
    done: 'Conversión terminada',
    failed: 'Falló la conversión',
  },
} as const;

type NoticeKind = keyof typeof KINDS;
const isNoticeKind = (type: string): type is NoticeKind => type in KINDS;

/**
 * ¿Este fin de trabajo avisa? Solo terminado o fallido (cancelar lo hace uno
 * mismo). Una descarga que se convierte al terminar (`then`, D-093) no avisa
 * al bajar: avisa su conversión, que hereda la lista. Si la descarga falla, sí.
 */
export function shouldNotify(record: JobRecord): boolean {
  if (!isNoticeKind(record.type) || record.notifyUserIds.length === 0) return false;
  if (record.status !== 'done' && record.status !== 'failed') return false;
  if (record.type === 'download' && record.status === 'done') {
    const params = downloadParamsSchema.safeParse(record.params);
    if (params.success && params.data.then) return false;
  }
  return true;
}

/** El mail de un trabajo terminado o fallido (texto plano: se lee bien en cualquier cliente). */
export function jobNoticeMessage(
  record: JobRecord,
  to: readonly string[],
  requesterName: string | null,
  publicUrl: string | null,
): MailMessage {
  const kind = KINDS[isNoticeKind(record.type) ? record.type : 'download'];
  const title =
    record.title ?? (record.type === 'recording' ? 'Grabación de pantalla' : 'Sin título');
  const failed = record.status === 'failed';
  const pc = record.clientHost ?? record.clientIp;
  const requester =
    requesterName !== null ? (pc !== null ? `${requesterName} (desde ${pc})` : requesterName) : pc;
  const details: [string, string | null][] = failed
    ? [['Motivo', record.error]]
    : [
        ['Duración', duration(record.durationSeconds)],
        ['Resolución', record.resolution],
        ['Tamaño', size(record.sizeBytes)],
      ];
  details.push(
    ['Pedida por', requester],
    ['Empezó', mailDateTime(record.createdAt)],
    [failed ? 'Falló' : 'Terminó', mailDateTime(record.finishedAt)],
  );
  const lines = details
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, value]) => `${label}: ${value}`);
  return {
    to: [...to],
    subject: `${failed ? kind.failed : kind.done}: ${title}`,
    text: [
      failed
        ? `${kind.noun} «${title}» no se pudo completar.`
        : `${kind.noun} «${title}» terminó y ya está en el Historial de STI-Catcher.`,
      '',
      ...lines,
      ...(publicUrl !== null ? ['', `Historial: ${publicUrl}/historial`] : []),
      '',
      'Te llega porque te eligieron para avisarte al pedir este trabajo.',
      'Mensaje automático de STI-Catcher. No hace falta responder.',
    ].join('\n'),
  };
}

/**
 * Aviso por mail al terminar o fallar un trabajo (D-104), a las cuentas que
 * eligió quien lo pidió. Se engancha en `onFinished` de la cola y no la demora:
 * el envío sigue en segundo plano. Si falla, queda en el log (el trabajo igual
 * está en el Historial).
 */
export function createJobNotice(deps: JobNoticeDeps) {
  return (record: JobRecord): void => {
    if (!shouldNotify(record)) return;
    const recipients = deps.recipients(record.notifyUserIds);
    if (recipients.length === 0) return;
    const requesterName = record.userId === null ? null : deps.userName(record.userId);
    const message = jobNoticeMessage(
      record,
      recipients.map((r) => r.email),
      requesterName,
      deps.publicUrl,
    );
    deps
      .send(message)
      .then(() => {
        deps.logger.info(
          { jobId: record.id, status: record.status, recipients: message.to.length },
          'Aviso de trabajo enviado por mail',
        );
      })
      .catch((error: unknown) => {
        deps.logger.warn(
          {
            jobId: record.id,
            code: error instanceof MailError ? error.code : undefined,
            err: error instanceof MailError ? error.cause : error,
          },
          'No se pudo enviar el aviso por mail',
        );
      });
  };
}
