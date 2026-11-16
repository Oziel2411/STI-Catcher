import type { Db } from './connection.ts';

export type Migration = {
  /** Número correlativo, empezando en 1. Nunca se reutiliza ni se modifica una ya publicada. */
  version: number;
  name: string;
  sql: string;
  /**
   * Paso opcional en JS, después del SQL y en la misma transacción. Para
   * transformaciones que SQLite no sabe hacer (p. ej. quitar tildes).
   */
  migrate?: (db: Db) => void;
  /**
   * Para reconstruir una tabla (SQLite no sabe cambiar un CHECK): apaga las
   * claves foráneas mientras corre. Si no, borrar la tabla vieja dispararía
   * los `ON DELETE SET NULL` de las que la referencian. `PRAGMA foreign_keys`
   * no se puede cambiar dentro de una transacción, por eso lo hace migrate();
   * al final se verifica con `foreign_key_check` antes de confirmar.
   */
  foreignKeysOff?: boolean;
};

/**
 * Aplica las migraciones pendientes, en orden y cada una en su transacción.
 * La versión actual se guarda en `PRAGMA user_version` (un entero en el
 * encabezado del archivo), así no hace falta una tabla de control.
 *
 * Las migraciones son módulos TS y no archivos .sql para que queden dentro
 * del bundle de producción sin tener que copiar archivos aparte.
 *
 * @returns las migraciones aplicadas en esta llamada
 */
export function migrate(db: Db, migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migraciones mal numeradas: se esperaba la versión ${index + 1} y se encontró ${migration.version} (${migration.name}).`,
      );
    }
  });

  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > sorted.length) {
    throw new Error(
      `La base está en la versión ${current}, más nueva que este código (${sorted.length}). ¿Se instaló una versión anterior de la app?`,
    );
  }

  const pending = sorted.filter((migration) => migration.version > current);
  for (const migration of pending) {
    const restoreForeignKeys =
      migration.foreignKeysOff === true && db.pragma('foreign_keys', { simple: true }) === 1;
    if (restoreForeignKeys) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        migration.migrate?.(db);
        if (migration.foreignKeysOff) {
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length > 0) {
            throw new Error(
              `La migración ${migration.name} dejó ${String(broken.length)} referencias rotas.`,
            );
          }
        }
        // PRAGMA no acepta parámetros; version es un entero validado arriba.
        db.pragma(`user_version = ${String(migration.version)}`);
      })();
    } finally {
      if (restoreForeignKeys) db.pragma('foreign_keys = ON');
    }
  }
  return pending;
}
