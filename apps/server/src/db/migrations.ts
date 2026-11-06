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
      -- Cuentas locales (D-100). El mail es el usuario: se guarda en minúsculas.
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
];
