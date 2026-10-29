import { jobStatusSchema, jobTypeSchema } from '@sti-catcher/shared';
import type {
  JobFinish,
  JobRecord,
  JobsRepository,
  ListJobsFilter,
  NewJob,
} from '../jobs/types.ts';
import type { Db } from './connection.ts';

type JobRow = {
  id: string;
  type: string;
  status: string;
  params: string;
  source_url: string | null;
  title: string | null;
  format: string | null;
  resolution: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  size_bytes: number | null;
  duration_seconds: number | null;
  file_path: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  client_ip: string | null;
  client_id: string | null;
  parent_job_id: string | null;
};

function parseParams(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}

/** Fila → dominio. Valida tipo y estado: si la base tuviera un valor raro, falla acá y no en la UI. */
function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: jobTypeSchema.parse(row.type),
    status: jobStatusSchema.parse(row.status),
    params: parseParams(row.params),
    sourceUrl: row.source_url,
    title: row.title,
    format: row.format,
    resolution: row.resolution,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    sizeBytes: row.size_bytes,
    durationSeconds: row.duration_seconds,
    filePath: row.file_path,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    clientIp: row.client_ip,
    clientId: row.client_id,
    parentJobId: row.parent_job_id,
  };
}

/**
 * Repositorio de jobs sobre SQLite. Las transiciones de estado se hacen con
 * un `WHERE status = ...` en el mismo UPDATE: si dos acciones compiten (p. ej.
 * cancelar justo cuando arranca), solo una gana y la otra recibe `false`.
 */
export function createJobsRepository(db: Db): JobsRepository {
  const insertStmt = db.prepare<
    [
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(`
    INSERT INTO jobs (id, type, status, params, created_at, source_url, title, client_ip, client_id, parent_job_id)
    VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
  `);
  const getStmt = db.prepare<[string], JobRow>('SELECT * FROM jobs WHERE id = ?');
  const nextQueuedStmt = db.prepare<[], JobRow>(
    "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1",
  );
  const markRunningStmt = db.prepare<[string, string]>(
    "UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
  );
  const finishStmt = db.prepare<
    [
      string,
      string,
      string | null,
      string | null,
      number | null,
      number | null,
      string | null,
      string,
    ]
  >(`
    UPDATE jobs
       SET status = ?, finished_at = ?, error = ?,
           file_path = ?, size_bytes = ?, duration_seconds = ?,
           title = COALESCE(?, title)
     WHERE id = ? AND status IN ('queued', 'running')
  `);
  const runningIdsStmt = db.prepare<[], { id: string }>(
    "SELECT id FROM jobs WHERE status = 'running' ORDER BY created_at, rowid",
  );
  const failRunningStmt = db.prepare<[string, string]>(
    "UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'",
  );
  const countActiveStmt = db.prepare<[], { status: string; total: number }>(
    "SELECT status, COUNT(*) AS total FROM jobs WHERE status IN ('queued', 'running') GROUP BY status",
  );

  return {
    insert(job: NewJob) {
      // Tipar el insert con una tupla evita confundir el orden de las columnas.
      insertStmt.run(
        job.id,
        job.type,
        JSON.stringify(job.params ?? {}),
        job.createdAt,
        job.sourceUrl ?? null,
        job.title ?? null,
        job.clientIp ?? null,
        job.clientId ?? null,
        job.parentJobId ?? null,
      );
      const created = getStmt.get(job.id);
      if (!created) throw new Error(`No se pudo leer el job recién creado ${job.id}`);
      return toRecord(created);
    },

    get(id) {
      const row = getStmt.get(id);
      return row ? toRecord(row) : null;
    },

    list({ statuses, types, limit }: ListJobsFilter) {
      // Los filtros vienen validados por Zod (enums); igual se pasan como parámetros.
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (statuses && statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        args.push(...statuses);
      }
      if (types && types.length > 0) {
        where.push(`type IN (${types.map(() => '?').join(', ')})`);
        args.push(...types);
      }
      const sql = `SELECT * FROM jobs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY created_at DESC, rowid DESC LIMIT ?`;
      args.push(limit);
      return db
        .prepare<(string | number)[], JobRow>(sql)
        .all(...args)
        .map(toRecord);
    },

    nextQueued() {
      const row = nextQueuedStmt.get();
      return row ? toRecord(row) : null;
    },

    markRunning(id, startedAt) {
      return markRunningStmt.run(startedAt, id).changes === 1;
    },

    finish(id, patch: JobFinish) {
      const result = finishStmt.run(
        patch.status,
        patch.finishedAt,
        patch.error ?? null,
        patch.filePath ?? null,
        patch.sizeBytes ?? null,
        patch.durationSeconds ?? null,
        patch.title ?? null,
        id,
      );
      return result.changes === 1;
    },

    failAllRunning(error, finishedAt) {
      return db.transaction(() => {
        const ids = runningIdsStmt.all().map((row) => row.id);
        failRunningStmt.run(error, finishedAt);
        return ids;
      })();
    },

    countActive() {
      const counts = { queued: 0, running: 0 };
      for (const row of countActiveStmt.all()) {
        if (row.status === 'queued') counts.queued = row.total;
        if (row.status === 'running') counts.running = row.total;
      }
      return counts;
    },
  };
}
