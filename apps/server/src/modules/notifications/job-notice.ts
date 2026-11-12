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

const FINAL_STATUSES: ReadonlySet<JobRecord['status']> = new Set([
  'done',
  'failed',
  'cancelled',
  'expired',
]);

/**
 * Lo que se lista de un pedido agrupado (D-105): una descarga que se convirtió
 * al terminar (`then`) se muestra por su conversión, que es el archivo final.
 */
export function batchItems(members: readonly JobRecord[]): JobRecord[] {
  const ids = new Set(members.map((m) => m.id));
  return members.filter((m) => m.followUpJobId === null || !ids.has(m.followUpJobId));
}

/** ¿Terminaron todos los trabajos del pedido (bien, mal o cancelados)? */
export const batchFinished = (members: readonly JobRecord[]): boolean =>
  members.length > 0 && members.every((m) => FINAL_STATUSES.has(m.status));

const PLURALS = {
  download: { many: 'descargas', title: 'Descargas' },
  conversion: { many: 'conversiones', title: 'Conversiones' },
} as const;

/**
 * El mail de un pedido de varios trabajos (D-105): uno solo, al terminar
 * todos, con lo que quedó listo, lo que falló (y por qué) y lo cancelado.
 */
export function batchNoticeMessage(
  members: readonly JobRecord[],
  to: readonly string[],
  requesterName: string | null,
  publicUrl: string | null,
): MailMessage {
  const items = batchItems(members);
  // Un pedido de Descargar incluye sus conversiones encadenadas: se nombra por la descarga.
  const words = PLURALS[members.some((m) => m.type === 'download') ? 'download' : 'conversion'];
  const done = items.filter((m) => m.status === 'done');
  const failed = items.filter((m) => m.status === 'failed');
  const cancelled = items.filter((m) => m.status === 'cancelled' || m.status === 'expired');
  const name = (m: JobRecord) => m.title ?? 'Sin título';
  const first = members[0];
  const pc = first ? (first.clientHost ?? first.clientIp) : null;
  const requester =
    requesterName !== null ? (pc !== null ? `${requesterName} (desde ${pc})` : requesterName) : pc;
  const finishedAt =
    members
      .map((m) => m.finishedAt)
      .filter((at): at is string => at !== null)
      .sort()
      .at(-1) ?? null;

  const section = (label: string, list: JobRecord[], line: (m: JobRecord) => string) =>
    list.length === 0 ? [] : ['', `${label} (${String(list.length)}):`, ...list.map(line)];
  const metaEntries: [string, string | null][] = [
    ['Pedido por', requester],
    ['Empezó', mailDateTime(first?.createdAt ?? null)],
    ['Terminó', mailDateTime(finishedAt)],
  ];
  const meta = metaEntries
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, value]) => `${label}: ${value}`);

  const total = String(items.length);
  const ready = String(done.length);
  const subject =
    done.length === 0
      ? `Fallaron las ${words.many}: ninguna de ${total} quedó lista`
      : `${words.title} terminadas: ${ready} de ${total} listas`;
  const summary =
    done.length === 0
      ? 'Ninguna quedó lista.'
      : done.length === items.length
        ? 'Todas están en el Historial de STI-Catcher.'
        : `${ready} están en el Historial de STI-Catcher.`;

  return {
    to: [...to],
    subject,
    text: [
      `Terminó un pedido de ${total} ${words.many}. ${summary}`,
      ...section('Listas', done, (m) => {
        const extra = [size(m.sizeBytes), duration(m.durationSeconds)].filter(
          (value): value is string => value !== null,
        );
        return `- ${name(m)}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`;
      }),
      ...section('No se pudieron completar', failed, (m) =>
        m.error ? `- ${name(m)}: ${m.error}` : `- ${name(m)}`,
      ),
      ...section('Canceladas', cancelled, (m) => `- ${name(m)}`),
      '',
      ...meta,
      ...(publicUrl !== null ? ['', `Historial: ${publicUrl}/historial`] : []),
      '',
      'Te llega porque te eligieron para avisarte al pedir estos trabajos.',
      'Mensaje automático de STI-Catcher. No hace falta responder.',
    ].join('\n'),
  };
}

/** Lo que necesita el aviso agrupado (D-105). */
export type NoticeBatchDeps = {
  get: (id: string) => {
    userId: string;
    notifyUserIds: string[];
    closedAt: string | null;
    notifiedAt: string | null;
  } | null;
  members: (id: string) => JobRecord[];
  claimNotice: (id: string, at: string) => boolean;
  close: (id: string, at: string) => boolean;
  listStaleOpen: (before: string) => string[];
  listClosedPending: () => string[];
};

/**
 * Un pedido abierto sin trabajos nuevos durante este tiempo se cierra solo: la
 * web se cerró a mitad de la lista, o algún pedido falló antes de crear su trabajo.
 */
export const BATCH_GRACE_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Avisos por mail al terminar o fallar un trabajo (D-104), a las cuentas que
 * eligió quien lo pidió. Se engancha en `onFinished` de la cola y no la demora:
 * el envío sigue en segundo plano. Si falla, queda en el log (el trabajo igual
 * está en el Historial).
 *
 * Los trabajos de un pedido agrupado (D-105) no avisan de a uno: cuando el
 * pedido está cerrado y terminaron todos, sale un solo mail con la lista. Si al
 * final el pedido tiene un solo trabajo, el mail es el de siempre.
 */
export function createJobNotice(
  deps: JobNoticeDeps & { batches?: NoticeBatchDeps; now?: () => Date },
) {
  const now = deps.now ?? (() => new Date());

  // Envíos en curso: al detener el servicio se esperan (D-105), si no el
  // aviso de los trabajos que cortó el apagado se perdería.
  const inFlight = new Set<Promise<void>>();

  const deliver = (message: MailMessage, log: object) => {
    const sending = deps
      .send(message)
      .then(() => {
        deps.logger.info(
          { ...log, recipients: message.to.length },
          'Aviso de trabajo enviado por mail',
        );
      })
      .catch((error: unknown) => {
        deps.logger.warn(
          {
            ...log,
            code: error instanceof MailError ? error.code : undefined,
            err: error instanceof MailError ? error.cause : error,
          },
          'No se pudo enviar el aviso por mail',
        );
      })
      .finally(() => {
        inFlight.delete(sending);
      });
    inFlight.add(sending);
  };

  const notifySingle = (record: JobRecord): void => {
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
    deliver(message, { jobId: record.id, status: record.status });
  };

  /** Manda el mail del pedido si está cerrado y terminó todo. Una sola vez. */
  const evaluateBatch = (batchId: string): void => {
    const batches = deps.batches;
    if (!batches) return;
    const batch = batches.get(batchId);
    if (!batch || batch.closedAt === null || batch.notifiedAt !== null) return;
    const members = batches.members(batchId);
    if (members.length > 0 && !batchFinished(members)) return;
    if (!batches.claimNotice(batchId, now().toISOString())) return;
    const items = batchItems(members);
    const only = items.length === 1 ? items[0] : undefined;
    if (only) {
      // Un solo trabajo: el mail de siempre (sin la regla de la descarga con `then`,
      // que acá ya se resolvió mostrando la conversión).
      notifySingle({ ...only, notifyUserIds: batch.notifyUserIds });
      return;
    }
    // Todo cancelado (o nada): no se avisa, como un trabajo cancelado solo.
    if (!items.some((m) => m.status === 'done' || m.status === 'failed')) return;
    const recipients = deps.recipients(batch.notifyUserIds);
    if (recipients.length === 0) return;
    const message = batchNoticeMessage(
      members,
      recipients.map((r) => r.email),
      deps.userName(batch.userId),
      deps.publicUrl,
    );
    deliver(message, { batchId, jobs: items.length });
  };

  const notify = (record: JobRecord): void => {
    if (record.noticeBatchId !== null && deps.batches) {
      evaluateBatch(record.noticeBatchId);
      return;
    }
    notifySingle(record);
  };

  /**
   * Cierra los pedidos abandonados y revisa los cerrados que no avisaron (p. ej.
   * si el server se reinició justo cuando terminaba el último trabajo).
   */
  const sweep = (): void => {
    const batches = deps.batches;
    if (!batches) return;
    const at = now();
    const before = new Date(at.getTime() - BATCH_GRACE_MS).toISOString();
    for (const id of batches.listStaleOpen(before)) batches.close(id, at.toISOString());
    for (const id of batches.listClosedPending()) evaluateBatch(id);
  };

  /**
   * Al arrancar: los trabajos que cortó un reinicio (quedaron «interrumpido»)
   * avisan como cualquier fallido. Los de un pedido los resuelve el barrido.
   */
  const notifyInterrupted = (records: readonly JobRecord[]): void => {
    for (const record of records) {
      if (record.noticeBatchId === null) notifySingle(record);
    }
  };

  /** Espera los envíos en curso, hasta `timeoutMs` (al detener el servicio). */
  const drain = async (timeoutMs: number): Promise<void> => {
    if (inFlight.size === 0) return;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timeout);
  };

  let timer: NodeJS.Timeout | null = null;
  return Object.assign(notify, {
    evaluateBatch,
    sweep,
    notifyInterrupted,
    drain,
    start() {
      timer = setInterval(sweep, SWEEP_INTERVAL_MS);
      timer.unref();
      sweep();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });
}

export type JobNotice = ReturnType<typeof createJobNotice>;
