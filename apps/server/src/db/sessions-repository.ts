import type { Db } from './connection.ts';

/** Una sesión abierta (D-104). Se identifica por el SHA-256 del token, nunca por el token. */
export type SessionRecord = {
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
};

type SessionRow = {
  token_hash: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
};

const toSession = (row: SessionRow): SessionRecord => ({
  tokenHash: row.token_hash,
  userId: row.user_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  ip: row.ip,
});

export type SessionsRepository = {
  insert(session: SessionRecord): void;
  get(tokenHash: string): SessionRecord | null;
  touch(tokenHash: string, at: string): void;
  delete(tokenHash: string): void;
  /** Corta todas las sesiones de una cuenta (desactivarla, cambiar la contraseña). */
  deleteForUser(userId: string): number;
  /** Corta las demás sesiones de una cuenta (al cambiar la contraseña, queda la actual). */
  deleteForUserExcept(userId: string, keepTokenHash: string): number;
  /** Borra las que no se usan desde antes de `before` (ISO). */
  deleteIdle(before: string): number;
};

export function createSessionsRepository(db: Db): SessionsRepository {
  const insertStmt = db.prepare<[SessionRecord]>(`
    INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, ip)
    VALUES (@tokenHash, @userId, @createdAt, @lastSeenAt, @ip)
  `);
  const getStmt = db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE token_hash = ?');
  const touchStmt = db.prepare<[string, string]>(
    'UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?',
  );
  const deleteStmt = db.prepare<[string]>('DELETE FROM sessions WHERE token_hash = ?');
  const deleteForUserStmt = db.prepare<[string]>('DELETE FROM sessions WHERE user_id = ?');
  const deleteOthersStmt = db.prepare<[string, string]>(
    'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?',
  );
  const deleteIdleStmt = db.prepare<[string]>('DELETE FROM sessions WHERE last_seen_at < ?');

  return {
    insert(session) {
      insertStmt.run(session);
    },
    get(tokenHash) {
      const row = getStmt.get(tokenHash);
      return row ? toSession(row) : null;
    },
    touch(tokenHash, at) {
      touchStmt.run(at, tokenHash);
    },
    delete(tokenHash) {
      deleteStmt.run(tokenHash);
    },
    deleteForUser(userId) {
      return deleteForUserStmt.run(userId).changes;
    },
    deleteForUserExcept(userId, keepTokenHash) {
      return deleteOthersStmt.run(userId, keepTokenHash).changes;
    },
    deleteIdle(before) {
      return deleteIdleStmt.run(before).changes;
    },
  };
}
