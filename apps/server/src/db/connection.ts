import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Abre la base SQLite con la configuración del proyecto.
 * - WAL: las lecturas (historial, SSE) no bloquean a las escrituras de la cola.
 * - busy_timeout: si otra conexión tiene el lock, espera en vez de fallar al instante.
 * - foreign_keys: SQLite las trae apagadas por defecto.
 * - synchronous=NORMAL: con WAL es seguro ante cortes del proceso; solo un corte
 *   de luz podría perder la última transacción, nunca corromper la base.
 */
export function openDatabase(filePath: string): Db {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}
