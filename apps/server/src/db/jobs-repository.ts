import { jobStatusSchema, jobTypeSchema } from '@sti-catcher/shared';
import type {
  HistoryFilter,
  JobFinish,
  JobRecord,
  JobsRepository,
  ListJobsFilter,
  NewJob,
} from '../jobs/types.ts';
import type { Db } from './connection.ts';
import { escapeLike, normalizeSearchText } from './search.ts';

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
      {
        id: string;
        type: string;
        params: string;
        createdAt: string;
        sourceUrl: string | null;
        title: string | null;
        titleSearch: string | null;
        clientIp: string | null;
        clientId: string | null;
        parentJobId: string | null;
      },
    ]
  >(`
    INSERT INTO jobs (id, type, status, params, created_at, source_url, title, title_search,
                      client_ip, client_id, parent_job_id)
    VALUES (@id, @type, 'queued', @params, @createdAt, @sourceUrl, @title, @titleSearch,
            @clientIp, @clientId, @parentJobId)
  `);
  const getStmt = db.prepare<[string], JobRow>('SELECT * FROM jobs WHERE id = ?');
  const nextQueuedStmt = db.prepare<[], JobRow>(
    "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1",
  );
  const markRunningStmt = db.prepare<[string, string]>(
    "UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
  );
  // Parámetros con nombre: con tantas columnas, los posicionales son fáciles de desordenar.
  const finishStmt = db.prepare<
    [
      {
        id: string;
        status: string;
        finishedAt: string;
        error: string | null;
        filePath: string | null;
        sizeBytes: number | null;
        durationSeconds: number | null;
        title: string | null;
        titleSearch: string | null;
        format: string | null;
        resolution: string | null;
        videoCodec: string | null;
        audioCodec: string | null;
      },
    ]
  >(`
    UPDATE jobs
       SET status = @status, finished_at = @finishedAt, error = @error,
           file_path = @filePath, size_bytes = @sizeBytes, duration_seconds = @durationSeconds,
           title = COALESCE(@title, title),
           title_search = COALESCE(@titleSearch, title_search),
           format = @format, resolution = @resolution,
           video_codec = @videoCodec, audio_codec = @audioCodec
     WHERE id = @id AND status IN ('queued', 'running')
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
  // done → expired: la única transición desde un estado final (el archivo ya no está).
  const markExpiredStmt = db.prepare<[string]>(
    "UPDATE jobs SET status = 'expired' WHERE id = ? AND status = 'done'",
  );
  const deleteStmt = db.prepare<[string]>(
    "DELETE FROM jobs WHERE id = ? AND status NOT IN ('queued', 'running')",
  );

  /** WHERE del historial; los valores van como parámetros (nunca concatenados). */
  const historyWhere = (filter: HistoryFilter) => {
    const where = [`type IN (${filter.types.map(() => '?').join(', ')})`];
    const args: string[] = [...filter.types];
    if (filter.clientId !== null) {
      where.push('client_id = ?');
      args.push(filter.clientId);
    }
    const search = filter.search === null ? '' : normalizeSearchText(filter.search);
    if (search !== '') {
      where.push("title_search LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(search)}%`);
    }
    return { sql: where.join(' AND '), args };
  };

  return {
    insert(job: NewJob) {
      const title = job.title ?? null;
      insertStmt.run({
        id: job.id,
        type: job.type,
        params: JSON.stringify(job.params ?? {}),
        createdAt: job.createdAt,
        sourceUrl: job.sourceUrl ?? null,
        title,
        titleSearch: title === null ? null : normalizeSearchText(title),
        clientIp: job.clientIp ?? null,
        clientId: job.clientId ?? null,
        parentJobId: job.parentJobId ?? null,
      });
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
      const result = finishStmt.run({
        id,
        status: patch.status,
        finishedAt: patch.finishedAt,
        error: patch.error ?? null,
        filePath: patch.filePath ?? null,
        sizeBytes: patch.sizeBytes ?? null,
        durationSeconds: patch.durationSeconds ?? null,
        title: patch.title ?? null,
        titleSearch: patch.title ? normalizeSearchText(patch.title) : null,
        format: patch.format ?? null,
        resolution: patch.resolution ?? null,
        videoCodec: patch.videoCodec ?? null,
        audioCodec: patch.audioCodec ?? null,
      });
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

    markExpired(id) {
      return markExpiredStmt.run(id).changes === 1;
    },

    delete(id) {
      return deleteStmt.run(id).changes === 1;
    },

    listHistory(filter) {
      const { sql, args } = historyWhere(filter);
      const total =
        db
          .prepare<string[], { total: number }>(`SELECT COUNT(*) AS total FROM jobs WHERE ${sql}`)
          .get(...args)?.total ?? 0;
      const rows = db
        .prepare<(string | number)[], JobRow>(
          `SELECT * FROM jobs WHERE ${sql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, filter.limit, filter.offset);
      return { records: rows.map(toRecord), total };
    },
  };
}
