import type { Db } from './connection.ts';
import type { Migration } from './migrate.ts';
import { normalizeSearchText } from './search.ts';

/**
 * Migraciones del esquema, en orden. Para cambiar el esquema se agrega una
 * nueva al final: nunca se edita una existente (ya puede estar aplicada en el servidor).
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'create-jobs',
    sql: /* sql */ `
      CREATE TABLE jobs (
        id               TEXT PRIMARY KEY,
        type             TEXT NOT NULL
                         CHECK (type IN ('download', 'upload', 'conversion', 'recording', 'selftest')),
        status           TEXT NOT NULL
                         CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled', 'expired')),
        -- Opciones del job (JSON), validadas por el runner de cada tipo.
        params           TEXT NOT NULL DEFAULT '{}',

        source_url       TEXT,
        title            TEXT,
        format           TEXT,
        resolution       TEXT,
        video_codec      TEXT,
        audio_codec      TEXT,
        size_bytes       INTEGER,
        duration_seconds REAL,
        -- Relativa a STORAGE_DIR, p. ej. "files/<id>.mp4". Nunca una ruta del cliente.
        file_path        TEXT,

        -- ISO 8601 en UTC.
        created_at       TEXT NOT NULL,
        started_at       TEXT,
        finished_at      TEXT,

        error            TEXT,
        client_ip        TEXT,
        client_id        TEXT,
        parent_job_id    TEXT REFERENCES jobs (id) ON DELETE SET NULL
      );

      -- Cola: próximo job en estado queued, por orden de llegada.
      CREATE INDEX jobs_status_created ON jobs (status, created_at);
      -- Historial: listado por fecha, "Mis trabajos" y conversiones de un archivo.
      CREATE INDEX jobs_created ON jobs (created_at);
      CREATE INDEX jobs_client_created ON jobs (client_id, created_at);
      CREATE INDEX jobs_parent ON jobs (parent_job_id);
    `,
  },
  {
    version: 2,
    name: 'add-title-search',
    sql: /* sql */ `
      -- Título en minúsculas y sin tildes, para buscar en el historial (ver db/search.ts).
      ALTER TABLE jobs ADD COLUMN title_search TEXT;
    `,
    // Completa los registros existentes: SQLite no sabe quitar tildes.
    migrate: (db) => {
      const rows = db
        .prepare<[], { id: string; title: string }>(
          'SELECT id, title FROM jobs WHERE title IS NOT NULL',
        )
        .all();
      const update = db.prepare<[string, string]>('UPDATE jobs SET title_search = ? WHERE id = ?');
      for (const row of rows) update.run(normalizeSearchText(row.title), row.id);
    },
  },
  {
    version: 3,
    name: 'create-recordings',
    sql: /* sql */ `
      -- Sesiones de grabación de pantalla (Fase 6). Los fragmentos llegan
      -- mientras se graba y se agregan a STORAGE_DIR/recordings/<id>.<ext>;
      -- al terminar se crea un job 'recording' que normaliza a MP4.
      CREATE TABLE recordings (
        id             TEXT PRIMARY KEY,
        status         TEXT NOT NULL CHECK (status IN ('recording', 'finalized', 'discarded')),
        mime_type      TEXT NOT NULL,
        extension      TEXT NOT NULL,
        fps            INTEGER NOT NULL,
        title          TEXT NOT NULL,
        client_id      TEXT,
        client_ip      TEXT,
        -- Próximo número de fragmento esperado (los anteriores ya están en disco).
        next_seq       INTEGER NOT NULL DEFAULT 0,
        size_bytes     INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        last_chunk_at  TEXT,
        job_id         TEXT REFERENCES jobs (id) ON DELETE SET NULL
      );
      -- Barrido de grabaciones abandonadas.
      CREATE INDEX recordings_status ON recordings (status, last_chunk_at);
    `,
  },
  {
    version: 4,
    name: 'add-follow-up-job',
    sql: /* sql */ `
      -- Descarga con conversión encadenada (D-093): la conversión que se creó al
      -- terminar. No alcanza con parent_job_id: un archivo puede tener varias
      -- conversiones hechas a mano desde el historial.
      ALTER TABLE jobs ADD COLUMN follow_up_job_id TEXT REFERENCES jobs (id) ON DELETE SET NULL;
    `,
  },
  {
    version: 5,
    name: 'add-client-host',
    sql: /* sql */ `
      -- Nombre de la PC que hizo el pedido (D-098), resuelto al crear el job.
      -- Se guarda (no se calcula al mirar) porque una IP puede pasar a otra PC.
      ALTER TABLE jobs ADD COLUMN client_host TEXT;
    `,
  },
  {
    version: 6,
    name: 'create-users-and-sessions',
    sql: /* sql */ `
      -- Cuentas locales (D-104). El mail es el usuario: se guarda en minúsculas.
      CREATE TABLE users (
        id                   TEXT PRIMARY KEY,
        email                TEXT NOT NULL UNIQUE,
        name                 TEXT NOT NULL,
        role                 TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        -- scrypt$<log2 N>$<r>$<p>$<sal>$<hash> (base64). Nunca sale por la API.
        password_hash        TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        last_login_at        TEXT
      );

      -- Sesiones abiertas. Se guarda el SHA-256 del token, no el token: quien
      -- lea la base no puede usarlas.
      CREATE TABLE sessions (
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ip           TEXT
      );
      CREATE INDEX sessions_user ON sessions (user_id);

      -- Dueño de cada trabajo y grabación. Los anteriores quedan sin cuenta (NULL).
      ALTER TABLE jobs ADD COLUMN user_id TEXT REFERENCES users (id) ON DELETE SET NULL;
      CREATE INDEX jobs_user_status ON jobs (user_id, status);
      ALTER TABLE recordings ADD COLUMN user_id TEXT REFERENCES users (id) ON DELETE SET NULL;
    `,
  },
  {
    version: 7,
    name: 'create-password-resets',
    sql: /* sql */ `
      -- Links para recuperar la contraseña por mail (D-104). Como las sesiones,
      -- se guarda el SHA-256 del token, nunca el token.
      CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at    TEXT,
        ip         TEXT
      );
      CREATE INDEX password_resets_user ON password_resets (user_id);
    `,
  },
  {
    version: 8,
    name: 'add-notify-user-ids',
    sql: /* sql */ `
      -- A quién avisar por mail cuando termina o falla (D-104): JSON con ids
      -- de cuentas. Se guardan ids, no mails: al mandar se usa el mail vigente
      -- y se saltean las cuentas desactivadas. La grabación lo elige al empezar
      -- y lo pasa a su job al cerrarse.
      ALTER TABLE jobs ADD COLUMN notify_user_ids TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE recordings ADD COLUMN notify_user_ids TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 9,
    name: 'create-notice-batches',
    sql: /* sql */ `
      -- Aviso agrupado (D-105): varios trabajos pedidos de una vez (una lista
      -- de links o de archivos) mandan un solo mail cuando terminan todos.
      -- closed_at: la web terminó de crear los trabajos del pedido (o pasó el
      -- tiempo de gracia). notified_at: el mail ya salió (se reclama una vez).
      CREATE TABLE notice_batches (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        notify_user_ids TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        closed_at       TEXT,
        notified_at     TEXT
      );
      CREATE INDEX notice_batches_pending ON notice_batches (notified_at);
      ALTER TABLE jobs ADD COLUMN notice_batch_id TEXT;
      CREATE INDEX jobs_notice_batch ON jobs (notice_batch_id);
    `,
  },
  {
    version: 10,
    name: 'create-recording-schedules',
    sql: /* sql */ `
      -- Grabaciones programadas (D-109): la espera vive en la pestaña, pero el
      -- server guarda la hora para avisar si no empezó (pestaña cerrada, PC
      -- suspendida). Pendiente = sin started_at, cancelled_at ni failed_at.
      -- next_action: lugar para una acción encadenada al terminar (convertir o
      -- comprimir); todavía no se usa.
      CREATE TABLE recording_schedules (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        notify_user_ids TEXT NOT NULL,
        start_at        TEXT NOT NULL,
        stop_at         TEXT,
        client_ip       TEXT,
        created_at      TEXT NOT NULL,
        recording_id    TEXT,
        started_at      TEXT,
        cancelled_at    TEXT,
        failed_at       TEXT,
        failure         TEXT,
        next_action     TEXT
      );
      CREATE INDEX recording_schedules_pending ON recording_schedules (start_at)
        WHERE started_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL;
    `,
  },
  {
    version: 11,
    name: 'add-compression-job-type',
    // Compresión de video (D-108): un tipo de job nuevo. SQLite no sabe cambiar
    // un CHECK, así que se reconstruye la tabla (ver rebuildJobsTypeCheck).
    sql: '',
    migrate: (db) => {
      rebuildJobsTypeCheck(db, [
        'download',
        'upload',
        'conversion',
        'compression',
        'recording',
        'selftest',
      ]);
    },
    foreignKeysOff: true,
  },
  {
    version: 12,
    name: 'add-edit-job-type',
    // Recortar y dividir (D-114): otro tipo de job, mismo procedimiento que la 11.
    sql: '',
    migrate: (db) => {
      rebuildJobsTypeCheck(db, [
        'download',
        'upload',
        'conversion',
        'compression',
        'edit',
        'recording',
        'selftest',
      ]);
    },
    foreignKeysOff: true,
  },
  {
    version: 13,
    name: 'add-trash',
    // Papelera del historial (D-115): lo borrado se guarda unos días antes de irse.
    // trash_kind: 'file' (solo el archivo; la fila se ve) o 'job' (la fila no se ve).
    // trash_path: el archivo movido a STORAGE_DIR\trash (relativo a STORAGE_DIR).
    // restored_at: la retención vuelve a contar desde que se restauró.
    sql: `
      ALTER TABLE jobs ADD COLUMN trashed_at TEXT;
      ALTER TABLE jobs ADD COLUMN trash_kind TEXT CHECK (trash_kind IN ('file', 'job'));
      ALTER TABLE jobs ADD COLUMN trash_path TEXT;
      ALTER TABLE jobs ADD COLUMN restored_at TEXT;
      CREATE INDEX idx_jobs_trashed ON jobs (trashed_at) WHERE trashed_at IS NOT NULL;
    `,
  },
];

/**
 * Cambia la lista de tipos del `CHECK` de `jobs.type` reconstruyendo la tabla
 * (el procedimiento de la documentación de SQLite para cambios que ALTER TABLE
 * no hace). Parte del `CREATE TABLE` guardado en la base, que ya incluye las
 * columnas agregadas después: así no se pierde ninguna aunque otra migración
 * haya sumado columnas. Copia los datos, cambia el nombre y vuelve a crear los
 * índices tal como estaban. Corre con las claves foráneas apagadas
 * (`foreignKeysOff`), para que borrar la tabla vieja no toque las referencias.
 */
export function rebuildJobsTypeCheck(db: Db, types: readonly string[]): void {
  if (!types.every((type) => /^[a-z]+$/.test(type))) {
    throw new Error('Tipos de job inválidos para el CHECK');
  }
  const table = db
    .prepare<[], { sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'",
    )
    .get();
  const indexes = db
    .prepare<[], { sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL",
    )
    .all();
  const check = /CHECK \(type IN \([^)]*\)\)/;
  const create = /^CREATE TABLE "?jobs"? \(/;
  if (!table || !check.test(table.sql) || !create.test(table.sql)) {
    throw new Error('La tabla jobs no tiene la forma esperada para cambiar sus tipos');
  }
  const list = types.map((type) => `'${type}'`).join(', ');
  db.exec(
    table.sql
      .replace(check, `CHECK (type IN (${list}))`)
      .replace(create, 'CREATE TABLE jobs_rebuild ('),
  );
  db.exec('INSERT INTO jobs_rebuild SELECT * FROM jobs');
  db.exec('DROP TABLE jobs');
  db.exec('ALTER TABLE jobs_rebuild RENAME TO jobs');
  for (const index of indexes) db.exec(index.sql);
}
