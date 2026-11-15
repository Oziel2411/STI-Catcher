import type { MailMessage } from '../../adapters/mailer.ts';
import { mailDateTime } from './job-notice.ts';

/** Datos comunes de los avisos de una grabación programada (D-109). */
export type RecordingNoticeInfo = {
  title: string;
  /** Nombre de quien la programó. */
  requesterName: string | null;
  /** IP de la PC que graba (los avisos no esperan a resolver su nombre). */
  clientIp: string | null;
  publicUrl: string | null;
};

const hhmm = (iso: string | null) => mailDateTime(iso)?.split(' ')[1] ?? null;

function requesterLine(info: RecordingNoticeInfo): string | null {
  const { requesterName, clientIp } = info;
  if (requesterName === null) return clientIp;
  return clientIp === null ? requesterName : `${requesterName} (desde ${clientIp})`;
}

const footer = (info: RecordingNoticeInfo) => [
  ...(info.publicUrl !== null ? ['', `Historial: ${info.publicUrl}/historial`] : []),
  '',
  'Te llega porque te eligieron para avisarte al programar esta grabación.',
  'Mensaje automático de STI-Catcher. No hace falta responder.',
];

/** Empezó una grabación programada (inicio a una hora o corte automático). */
export function recordingStartedMessage(
  info: RecordingNoticeInfo & { startedAt: string; stopAt: string | null },
  to: readonly string[],
): MailMessage {
  const requester = requesterLine(info);
  return {
    to: [...to],
    subject: `Empezó la grabación: ${info.title}`,
    text: [
      `La grabación «${info.title}» empezó a las ${hhmm(info.startedAt) ?? '—'}.`,
      info.stopAt !== null
        ? `Está programada para terminar el ${mailDateTime(info.stopAt) ?? '—'}.`
        : 'Termina cuando alguien la detenga.',
      'Cuando termine de procesarse (o si falla) llega otro aviso.',
      ...(requester !== null ? ['', `Programada por: ${requester}`] : []),
      ...footer(info),
    ].join('\n'),
  };
}

/** Una grabación programada no empezó a su hora. */
export function recordingNotStartedMessage(
  info: RecordingNoticeInfo & { startAt: string; reason: string },
  to: readonly string[],
): MailMessage {
  const requester = requesterLine(info);
  return {
    to: [...to],
    subject: `No empezó la grabación programada: ${info.title}`,
    text: [
      `La grabación «${info.title}», programada para el ${mailDateTime(info.startAt) ?? '—'}, no empezó.`,
      '',
      `Motivo: ${info.reason}`,
      ...(requester !== null ? [`Programada por: ${requester}`] : []),
      '',
      'Para grabar hay que volver a programarla desde «Grabar pantalla», en la PC que va a grabar.',
      ...footer(info),
    ].join('\n'),
  };
}

/** Lo que usa el notificador de la cola de avisos (`createJobNotice`). */
export type NoticeSender = {
  sendTo: (userIds: readonly string[], build: (to: string[]) => MailMessage, log: object) => void;
  userName: (userId: string) => string | null;
  publicUrl: string | null;
};

/**
 * Avisos de grabación programada (D-109) sobre el notificador de la cola.
 * Sin servidor de correo (`null`) no hacen nada.
 */
export function createRecordingNotifier(notice: NoticeSender | null) {
  const nameOf = (userId: string | null) =>
    userId === null || notice === null ? null : notice.userName(userId);
  return {
    started(start: {
      recordingId: string;
      title: string;
      userId: string | null;
      clientIp: string | null;
      notifyUserIds: string[];
      startedAt: string;
      stopAt: string | null;
    }): void {
      if (notice === null) return;
      const info = {
        title: start.title,
        requesterName: nameOf(start.userId),
        clientIp: start.clientIp,
        publicUrl: notice.publicUrl,
        startedAt: start.startedAt,
        stopAt: start.stopAt,
      };
      notice.sendTo(start.notifyUserIds, (to) => recordingStartedMessage(info, to), {
        recordingId: start.recordingId,
        notice: 'started',
      });
    },
    notStarted(
      schedule: {
        id: string;
        title: string;
        userId: string;
        clientIp: string | null;
        notifyUserIds: string[];
        startAt: string;
      },
      reason: string,
    ): void {
      if (notice === null) return;
      const info = {
        title: schedule.title,
        requesterName: nameOf(schedule.userId),
        clientIp: schedule.clientIp,
        publicUrl: notice.publicUrl,
        startAt: schedule.startAt,
        reason,
      };
      notice.sendTo(schedule.notifyUserIds, (to) => recordingNotStartedMessage(info, to), {
        scheduleId: schedule.id,
        notice: 'not-started',
      });
    },
  };
}
