import type { Db } from './connection.ts';
import { parseIds } from './jobs-repository.ts';

/** Una grabación programada (D-109): la hora a la que tiene que empezar. */
export type RecordingScheduleRecord = {
  id: string;
  userId: string;
  title: string;
  notifyUserIds: string[];
  startAt: string;
  /** Corte previsto (si se programó), para el aviso. */
  stopAt: string | null;
  clientIp: string | null;
  createdAt: string;
  recordingId: string | null;
  startedAt: string | null;
  cancelledAt: string | null;
  failedAt: string | null;
  failure: string | null;
};

type Row = {
  id: string;
  user_id: string;
  title: string;
  notify_user_ids: string;
  start_at: string;
  stop_at: string | null;
  client_ip: string | null;
  created_at: string;
  recording_id: string | null;
  started_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  failure: string | null;
};

const toRecord = (row: Row): RecordingScheduleRecord => ({
  id: row.id,
  userId: row.user_id,
  title: row.title,
  notifyUserIds: parseIds(row.notify_user_ids),
  startAt: row.start_at,
  stopAt: row.stop_at,
  clientIp: row.client_ip,
  createdAt: row.created_at,
  recordingId: row.recording_id,
  startedAt: row.started_at,
  cancelledAt: row.cancelled_at,
  failedAt: row.failed_at,
  failure: row.failure,
});

const PENDING = 'started_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL';

export type RecordingSchedulesRepository = {
  insert(
    schedule: Pick<
      RecordingScheduleRecord,
      'id' | 'userId' | 'title' | 'notifyUserIds' | 'startAt' | 'stopAt' | 'clientIp' | 'createdAt'
    >,
  ): void;
  get(id: string): RecordingScheduleRecord | null;
  /**
   * Empezó: queda vinculada a su grabación. También si ya se había avisado que
   * no empezó (llegó tarde). false si se canceló o ya había empezado.
   */
  markStarted(id: string, recordingId: string, at: string): boolean;
  /** Cancelada por quien la programó. false si ya no estaba pendiente. */
  cancel(id: string, at: string): boolean;
  /** No empezó, con el motivo. false si ya no estaba pendiente (solo se avisa una vez). */
  markFailed(id: string, at: string, failure: string): boolean;
  /** Pendientes cuya hora de inicio es anterior a `before` (ISO). */
  listOverdue(before: string): RecordingScheduleRecord[];
};

export function createRecordingSchedulesRepository(db: Db): RecordingSchedulesRepository {
  const insertStmt = db.prepare<
    [
      {
        id: string;
        userId: string;
        title: string;
        notifyUserIds: string;
        startAt: string;
        stopAt: string | null;
        clientIp: string | null;
        createdAt: string;
      },
    ]
  >(`
    INSERT INTO recording_schedules
      (id, user_id, title, notify_user_ids, start_at, stop_at, client_ip, created_at)
    VALUES (@id, @userId, @title, @notifyUserIds, @startAt, @stopAt, @clientIp, @createdAt)
  `);
  const getStmt = db.prepare<[string], Row>('SELECT * FROM recording_schedules WHERE id = ?');
  const startStmt = db.prepare<[string, string, string]>(`
    UPDATE recording_schedules SET recording_id = ?, started_at = ?
    WHERE id = ? AND started_at IS NULL AND cancelled_at IS NULL
  `);
  const cancelStmt = db.prepare<[string, string]>(
    `UPDATE recording_schedules SET cancelled_at = ? WHERE id = ? AND ${PENDING}`,
  );
  const failStmt = db.prepare<[string, string, string]>(
    `UPDATE recording_schedules SET failed_at = ?, failure = ? WHERE id = ? AND ${PENDING}`,
  );
  const overdueStmt = db.prepare<[string], Row>(
    `SELECT * FROM recording_schedules WHERE ${PENDING} AND start_at < ? ORDER BY start_at`,
  );

  return {
    insert(schedule) {
      insertStmt.run({ ...schedule, notifyUserIds: JSON.stringify(schedule.notifyUserIds) });
    },
    get(id) {
      const row = getStmt.get(id);
      return row ? toRecord(row) : null;
    },
    markStarted(id, recordingId, at) {
      return startStmt.run(recordingId, at, id).changes > 0;
    },
    cancel(id, at) {
      return cancelStmt.run(at, id).changes > 0;
    },
    markFailed(id, at, failure) {
      return failStmt.run(at, failure, id).changes > 0;
    },
    listOverdue(before) {
      return overdueStmt.all(before).map(toRecord);
    },
  };
}
