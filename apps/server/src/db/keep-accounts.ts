import type { Db } from './connection.ts';

/**
 * Migración a otro servidor sin el historial: en una base copiada quedan solo
 * las cuentas (mail, nombre, rol, contraseña). Lo usa
 * `npm run db:keep-accounts`.
 */

/** Tablas que se conservan tal cual. */
export const KEPT_TABLES = ['users'] as const;

/**
 * Tablas que se vacían, en este orden. Las sesiones y los links para
 * restablecer la contraseña también: en el servidor nuevo todos vuelven a
 * ingresar.
 */
export const CLEARED_TABLES = [
  'sessions',
  'password_resets',
  'notice_batches',
  'recording_schedules',
  'recordings',
  'jobs',
] as const;

export class UnknownTablesError extends Error {
  override name = 'UnknownTablesError';
}

export type KeepAccountsSummary = {
  users: number;
  deleted: Record<(typeof CLEARED_TABLES)[number], number>;
};

export function listTables(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .sort();
}

/** Filas de cada tabla, para mostrar antes de confirmar. */
export function countRows(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of listTables(db)) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    counts[table] = row.n;
  }
  return counts;
}

/**
 * Falla si la base tiene una tabla que no está en ninguna de las dos listas:
 * una migración nueva obliga a decidir si su contenido se migra o no.
 */
export function assertKnownTables(db: Db): void {
  const known = new Set<string>([...KEPT_TABLES, ...CLEARED_TABLES]);
  const unknown = listTables(db).filter((table) => !known.has(table));
  if (unknown.length > 0) {
    throw new UnknownTablesError(
      `La base tiene tablas que este comando no conoce (${unknown.join(', ')}). No se tocó nada.`,
    );
  }
}

/** Borra todo menos las cuentas, en una transacción, y compacta el archivo. */
export function keepOnlyAccounts(db: Db): KeepAccountsSummary {
  assertKnownTables(db);
  const deleted = {} as KeepAccountsSummary['deleted'];
  db.transaction(() => {
    for (const table of CLEARED_TABLES) {
      deleted[table] = db.prepare(`DELETE FROM ${table}`).run().changes;
    }
  })();
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
  const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  return { users, deleted };
}
