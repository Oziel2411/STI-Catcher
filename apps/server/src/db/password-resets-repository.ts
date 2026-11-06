import type { Db } from './connection.ts';

/** Un link de recuperación (D-100). Se identifica por el SHA-256 del token. */
export type PasswordResetRecord = {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  ip: string | null;
};

type Row = {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  ip: string | null;
};

const toRecord = (row: Row): PasswordResetRecord => ({
  tokenHash: row.token_hash,
  userId: row.user_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  usedAt: row.used_at,
  ip: row.ip,
});

export type PasswordResetsRepository = {
  insert(reset: Omit<PasswordResetRecord, 'usedAt'>): void;
  get(tokenHash: string): PasswordResetRecord | null;
  /** Lo marca usado. false si ya estaba usado (dos pedidos a la vez: gana uno). */
  markUsed(tokenHash: string, at: string): boolean;
  /** Invalida los links sin usar de una cuenta (al pedir uno nuevo o al cambiar la contraseña). */
  deleteUnusedForUser(userId: string): void;
  /** Borra los vencidos antes de `before` (ISO). */
  deleteExpired(before: string): void;
};

export function createPasswordResetsRepository(db: Db): PasswordResetsRepository {
  const insertStmt = db.prepare<[Omit<PasswordResetRecord, 'usedAt'>]>(`
    INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, ip)
    VALUES (@tokenHash, @userId, @createdAt, @expiresAt, @ip)
  `);
  const getStmt = db.prepare<[string], Row>('SELECT * FROM password_resets WHERE token_hash = ?');
  const markUsedStmt = db.prepare<[string, string]>(
    'UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
  );
  const deleteUnusedStmt = db.prepare<[string]>(
    'DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL',
  );
  const deleteExpiredStmt = db.prepare<[string]>(
    'DELETE FROM password_resets WHERE expires_at < ?',
  );

  return {
    insert(reset) {
      insertStmt.run(reset);
    },
    get(tokenHash) {
      const row = getStmt.get(tokenHash);
      return row ? toRecord(row) : null;
    },
    markUsed(tokenHash, at) {
      return markUsedStmt.run(at, tokenHash).changes === 1;
    },
    deleteUnusedForUser(userId) {
      deleteUnusedStmt.run(userId);
    },
    deleteExpired(before) {
      deleteExpiredStmt.run(before);
    },
  };
}
