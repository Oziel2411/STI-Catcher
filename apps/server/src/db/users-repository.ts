import { userRoleSchema } from '@sti-catcher/shared';
import type { UserRole } from '@sti-catcher/shared';
import type { Db } from './connection.ts';

/** Una cuenta tal como se guarda (D-100). `passwordHash` nunca sale por la API. */
export type UserRecord = {
  id: string;
  /** En minúsculas. */
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
  passwordHash: string;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  active: number;
  password_hash: string;
  must_change_password: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: userRoleSchema.parse(row.role),
  active: row.active === 1,
  passwordHash: row.password_hash,
  mustChangePassword: row.must_change_password === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastLoginAt: row.last_login_at,
});

export type NewUser = Pick<
  UserRecord,
  'id' | 'email' | 'name' | 'role' | 'passwordHash' | 'mustChangePassword' | 'createdAt'
>;

export type UsersRepository = {
  /** Lanza si el mail ya existe (UNIQUE): quien llama lo verifica antes. */
  insert(user: NewUser): UserRecord;
  get(id: string): UserRecord | null;
  findByEmail(email: string): UserRecord | null;
  /** Nombre de varias cuentas a la vez (historial). */
  namesByIds(ids: readonly string[]): Map<string, string>;
  setLastLogin(id: string, at: string): void;
  countAdmins(): number;
};

export function createUsersRepository(db: Db): UsersRepository {
  const insertStmt = db.prepare<
    [
      {
        id: string;
        email: string;
        name: string;
        role: string;
        passwordHash: string;
        mustChangePassword: number;
        createdAt: string;
      },
    ]
  >(`
    INSERT INTO users (id, email, name, role, password_hash, must_change_password,
                       created_at, updated_at)
    VALUES (@id, @email, @name, @role, @passwordHash, @mustChangePassword, @createdAt, @createdAt)
  `);
  const getStmt = db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?');
  const byEmailStmt = db.prepare<[string], UserRow>('SELECT * FROM users WHERE email = ?');
  const lastLoginStmt = db.prepare<[string, string]>(
    'UPDATE users SET last_login_at = ? WHERE id = ?',
  );
  const countAdminsStmt = db.prepare<[], { total: number }>(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND active = 1",
  );

  return {
    insert(user) {
      insertStmt.run({
        ...user,
        email: user.email.toLowerCase(),
        mustChangePassword: user.mustChangePassword ? 1 : 0,
      });
      const row = getStmt.get(user.id);
      if (!row) throw new Error(`No se pudo leer la cuenta recién creada ${user.id}`);
      return toUser(row);
    },

    get(id) {
      const row = getStmt.get(id);
      return row ? toUser(row) : null;
    },

    findByEmail(email) {
      const row = byEmailStmt.get(email.trim().toLowerCase());
      return row ? toUser(row) : null;
    },

    namesByIds(ids) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return new Map();
      const rows = db
        .prepare<string[], { id: string; name: string }>(
          `SELECT id, name FROM users WHERE id IN (${unique.map(() => '?').join(', ')})`,
        )
        .all(...unique);
      return new Map(rows.map((row) => [row.id, row.name]));
    },

    setLastLogin(id, at) {
      lastLoginStmt.run(at, id);
    },

    countAdmins() {
      return countAdminsStmt.get()?.total ?? 0;
    },
  };
}
