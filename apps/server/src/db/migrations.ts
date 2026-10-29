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
];
