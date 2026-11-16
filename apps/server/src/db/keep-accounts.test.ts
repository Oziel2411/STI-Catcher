import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.ts';
import { createJobsRepository } from './jobs-repository.ts';
import {
  CLEARED_TABLES,
  KEPT_TABLES,
  UnknownTablesError,
  countRows,
  keepOnlyAccounts,
  listTables,
} from './keep-accounts.ts';
import { migrate } from './migrate.ts';
import { migrations } from './migrations.ts';
import { createSessionsRepository } from './sessions-repository.ts';
import { createUsersRepository } from './users-repository.ts';

const USER = '00000000-0000-4000-8000-0000000000a1';
const JOB_A = '00000000-0000-4000-8000-00000000000a';
const JOB_B = '00000000-0000-4000-8000-00000000000b';

function seededDb() {
  const db = openDatabase(':memory:');
  migrate(db, migrations);
  createUsersRepository(db).insert({
    id: USER,
    email: 'ana@capitanes.ar',
    name: 'Ana',
    role: 'admin',
    passwordHash: 'scrypt$hash',
    mustChangePassword: false,
    createdAt: 't',
  });
  createSessionsRepository(db).insert({
    tokenHash: 'h',
    userId: USER,
    createdAt: 't',
    lastSeenAt: 't',
    ip: null,
  });
  const jobs = createJobsRepository(db);
  jobs.insert({ id: JOB_A, type: 'selftest', params: {}, createdAt: 't' });
  jobs.insert({ id: JOB_B, type: 'selftest', params: {}, createdAt: 't', parentJobId: JOB_A });
  db.prepare(
    "INSERT INTO notice_batches (id, user_id, notify_user_ids, created_at) VALUES ('nb', ?, '[]', 't')",
  ).run(USER);
  return db;
}

describe('keepOnlyAccounts', () => {
  it('cubre todas las tablas de la base: una migración nueva obliga a decidir', () => {
    const db = openDatabase(':memory:');
    migrate(db, migrations);
    expect(listTables(db)).toEqual([...KEPT_TABLES, ...CLEARED_TABLES].sort());
  });

  it('deja las cuentas con su contraseña y borra el resto', () => {
    const db = seededDb();
    const summary = keepOnlyAccounts(db);

    expect(summary.users).toBe(1);
    expect(summary.deleted).toMatchObject({ sessions: 1, jobs: 2, notice_batches: 1 });
    const counts = countRows(db);
    expect(counts.users).toBe(1);
    for (const table of CLEARED_TABLES) expect(counts[table]).toBe(0);
    const user = createUsersRepository(db).findByEmail('ana@capitanes.ar');
    expect(user?.passwordHash).toBe('scrypt$hash');
    expect(user?.role).toBe('admin');
  });

  it('con una tabla desconocida no toca nada', () => {
    const db = seededDb();
    db.exec('CREATE TABLE otra (x INTEGER)');
    expect(() => keepOnlyAccounts(db)).toThrow(UnknownTablesError);
    expect(countRows(db).jobs).toBe(2);
  });
});
