import { randomUUID } from 'node:crypto';
import type { CreateRecordingScheduleRequest } from '@sti-catcher/shared';
import type {
  RecordingScheduleRecord,
  RecordingSchedulesRepository,
} from '../../db/recording-schedules-repository.ts';
import type { Requester } from '../history/history-service.ts';

export class ScheduleError extends Error {
  override name = 'ScheduleError';
  constructor(
    readonly code: 'SCHEDULE_NOT_FOUND',
    message: string,
    readonly status: 404,
  ) {
    super(message);
  }
}

/** Cuánto se espera después de la hora de inicio antes de avisar que no empezó. */
export const SCHEDULE_GRACE_MS = 2 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

export const NOT_STARTED_REASON =
  'A la hora programada no empezó: la página de STI-Catcher se cerró, la PC se suspendió o se quedó sin conexión.';

/** Lo que tiene una grabación al empezar, para el aviso de inicio. */
export type RecordingStart = {
  recordingId: string;
  title: string;
  userId: string | null;
  clientIp: string | null;
  notifyUserIds: string[];
  startedAt: string;
  programmed: boolean;
  stopAt: string | null;
  scheduleId: string | null;
};

export type ScheduleServiceDeps = {
  repo: RecordingSchedulesRepository;
  /** Mails (D-109). Sin servidor de correo no hacen nada. */
  notifier: {
    started: (start: RecordingStart) => void;
    notStarted: (schedule: RecordingScheduleRecord, reason: string) => void;
  };
  logger: { info: (obj: object, msg: string) => void };
  now?: () => Date;
};

/**
 * Grabaciones programadas (D-109). La espera y el inicio siguen en la pestaña
 * (D-097): solo el navegador puede capturar la pantalla. El server guarda la
 * hora para avisar por mail si no empezó, y avisa también cuando empieza.
 */
export function createScheduleService(deps: ScheduleServiceDeps) {
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;

  const own = (id: string, requester: Requester): RecordingScheduleRecord => {
    const schedule = deps.repo.get(id);
    // De otra cuenta = no existe.
    if (!schedule || schedule.userId !== requester.userId) {
      throw new ScheduleError('SCHEDULE_NOT_FOUND', 'No existe esa programación.', 404);
    }
    return schedule;
  };

  const fail = (schedule: RecordingScheduleRecord, reason: string) => {
    if (!deps.repo.markFailed(schedule.id, now().toISOString(), reason)) return;
    deps.logger.info({ scheduleId: schedule.id, reason }, 'La grabación programada no empezó');
    deps.notifier.notStarted(schedule, reason);
  };

  const service = {
    create(request: CreateRecordingScheduleRequest, requester: Requester): string {
      if (requester.userId === null) throw new Error('Programar requiere una cuenta');
      const id = randomUUID();
      deps.repo.insert({
        id,
        userId: requester.userId,
        title: request.title,
        notifyUserIds: request.notify ?? [],
        startAt: new Date(request.startAt).toISOString(),
        stopAt: request.stopAt ? new Date(request.stopAt).toISOString() : null,
        clientIp: requester.ip,
        createdAt: now().toISOString(),
      });
      return id;
    },

    /** Idempotente: cancelar una que ya empezó o se canceló no hace nada. */
    cancel(id: string, requester: Requester): void {
      own(id, requester);
      deps.repo.cancel(id, now().toISOString());
    },

    /** La pestaña no pudo empezar: avisa en el momento, con el motivo. */
    fail(id: string, reason: string, requester: Requester): void {
      fail(own(id, requester), reason);
    },

    /** Empezó una grabación: cumple su programación (si es de esa cuenta) y avisa. */
    recordingStarted(start: RecordingStart): void {
      if (start.scheduleId !== null) {
        const schedule = deps.repo.get(start.scheduleId);
        if (schedule && schedule.userId === start.userId) {
          deps.repo.markStarted(schedule.id, start.recordingId, start.startedAt);
        }
      }
      if (start.programmed) deps.notifier.started(start);
    },

    /** Las que pasaron su hora (más el margen) sin empezar: avisa una vez. */
    sweep(): void {
      const before = new Date(now().getTime() - SCHEDULE_GRACE_MS).toISOString();
      for (const schedule of deps.repo.listOverdue(before)) fail(schedule, NOT_STARTED_REASON);
    },

    start(): void {
      timer = setInterval(() => {
        service.sweep();
      }, SWEEP_INTERVAL_MS);
      timer.unref();
      service.sweep();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return service;
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
