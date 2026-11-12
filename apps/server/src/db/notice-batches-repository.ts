import type { Db } from './connection.ts';
import { parseIds } from './jobs-repository.ts';

/** Un pedido de varios trabajos que avisa con un solo mail (D-105). */
export type NoticeBatchRecord = {
  id: string;
  userId: string;
  notifyUserIds: string[];
  createdAt: string;
  /** La web terminó de crear los trabajos (o venció el tiempo de gracia). */
  closedAt: string | null;
  /** El mail ya salió (o se decidió no mandarlo). */
  notifiedAt: string | null;
};

type Row = {
  id: string;
  user_id: string;
  notify_user_ids: string;
  created_at: string;
  closed_at: string | null;
  notified_at: string | null;
};

const toRecord = (row: Row): NoticeBatchRecord => ({
  id: row.id,
  userId: row.user_id,
  notifyUserIds: parseIds(row.notify_user_ids),
  createdAt: row.created_at,
  closedAt: row.closed_at,
  notifiedAt: row.notified_at,
});

export type NoticeBatchesRepository = {
  insert(batch: Pick<NoticeBatchRecord, 'id' | 'userId' | 'notifyUserIds' | 'createdAt'>): void;
  get(id: string): NoticeBatchRecord | null;
  /** Lo cierra. false si ya estaba cerrado. */
  close(id: string, at: string): boolean;
  /**
   * Reclama el envío del mail: solo uno gana aunque dos trabajos terminen a la
   * vez. false si no está cerrado o si ya se mandó.
   */
  claimNotice(id: string, at: string): boolean;
  /**
   * Abiertos sin novedades desde `before` (ISO): ni el pedido ni su último
   * trabajo son más nuevos. La web se cerró a mitad de la lista o falló un
   * pedido; se cierran solos.
   */
  listStaleOpen(before: string): string[];
  /** Cerrados que todavía no avisaron (se revisan al arrancar y en cada barrido). */
  listClosedPending(): string[];
};

export function createNoticeBatchesRepository(db: Db): NoticeBatchesRepository {
  const insertStmt = db.prepare<
    [{ id: string; userId: string; notifyUserIds: string; createdAt: string }]
  >(`
    INSERT INTO notice_batches (id, user_id, notify_user_ids, created_at)
    VALUES (@id, @userId, @notifyUserIds, @createdAt)
  `);
  const getStmt = db.prepare<[string], Row>('SELECT * FROM notice_batches WHERE id = ?');
  const closeStmt = db.prepare<[string, string]>(
    'UPDATE notice_batches SET closed_at = ? WHERE id = ? AND closed_at IS NULL',
  );
  const claimStmt = db.prepare<[string, string]>(`
    UPDATE notice_batches SET notified_at = ?
    WHERE id = ? AND closed_at IS NOT NULL AND notified_at IS NULL
  `);
  const staleStmt = db.prepare<[string, string], { id: string }>(`
    SELECT b.id FROM notice_batches b
    WHERE b.closed_at IS NULL AND b.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.notice_batch_id = b.id AND j.created_at >= ?)
  `);
  const pendingStmt = db.prepare<[], { id: string }>(
    'SELECT id FROM notice_batches WHERE closed_at IS NOT NULL AND notified_at IS NULL',
  );

  return {
    insert(batch) {
      insertStmt.run({ ...batch, notifyUserIds: JSON.stringify(batch.notifyUserIds) });
    },
    get(id) {
      const row = getStmt.get(id);
      return row ? toRecord(row) : null;
    },
    close(id, at) {
      return closeStmt.run(at, id).changes > 0;
    },
    claimNotice(id, at) {
      return claimStmt.run(at, id).changes > 0;
    },
    listStaleOpen(before) {
      return staleStmt.all(before, before).map((row) => row.id);
    },
    listClosedPending() {
      return pendingStmt.all().map((row) => row.id);
    },
  };
}
