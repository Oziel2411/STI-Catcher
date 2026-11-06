import { jobStatusSchema, jobTypeSchema } from '@sti-catcher/shared';
import type { JobType } from '@sti-catcher/shared';
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
  user_id: string | null;
  notify_user_ids: string;
  client_host: string | null;
  parent_job_id: string | null;
  follow_up_job_id: string | null;
};

/**
 * Quién pidió un trabajo, para el filtro del historial (D-098, D-104): `user:<id>`
 * si tiene cuenta; si es de antes del login, la PC (o la IP). Un nombre de PC o
 * una IP nunca empiezan con "user:".
 */
const REQUESTER_SQL =
  "CASE WHEN user_id IS NOT NULL THEN 'user:' || user_id ELSE COALESCE(client_host, client_ip) END";

/** JSON de ids de cuentas; algo raro = nadie. */
export function parseIds(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

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
    userId: row.user_id,
    notifyUserIds: parseIds(row.notify_user_ids),
    clientHost: row.client_host,
    parentJobId: row.parent_job_id,
    followUpJobId: row.follow_up_job_id,
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
        userId: string | null;
        notifyUserIds: string;
        parentJobId: string | null;
      },
    ]
  >(`
    INSERT INTO jobs (id, type, status, params, created_at, source_url, title, title_search,
                      client_ip, user_id, notify_user_ids, parent_job_id)
    VALUES (@id, @type, 'queued', @params, @createdAt, @sourceUrl, @title, @titleSearch,
            @clientIp, @userId, @notifyUserIds, @parentJobId)
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
  // Retención: no se borra el origen de una conversión que todavía lo va a leer.
  const expirableStmt = db.prepare<[string], { id: string; file_path: string }>(`
    SELECT j.id, j.file_path FROM jobs j
     WHERE j.status = 'done' AND j.file_path IS NOT NULL AND j.finished_at < ?
       AND NOT EXISTS (SELECT 1 FROM jobs c
                        WHERE c.parent_job_id = j.id AND c.status IN ('queued', 'running'))
     ORDER BY j.finished_at
  `);
  const activeByUserStmt = db.prepare<[string], { kind: string; total: number }>(`
    SELECT CASE
             WHEN j.type = 'conversion'
              AND EXISTS (SELECT 1 FROM jobs d WHERE d.follow_up_job_id = j.id) THEN 'download'
             ELSE j.type
           END AS kind,
           COUNT(*) AS total
      FROM jobs j
     WHERE j.user_id = ? AND j.status IN ('queued', 'running')
     GROUP BY kind
  `);
  const setClientHostStmt = db.prepare<[string, string]>(
    'UPDATE jobs SET client_host = ? WHERE id = ?',
  );
  const setFollowUpStmt = db.prepare<[string, string]>(
    'UPDATE jobs SET follow_up_job_id = ? WHERE id = ? AND follow_up_job_id IS NULL',
  );
  const liveFilePathsStmt = db.prepare<[], { file_path: string }>(
    "SELECT file_path FROM jobs WHERE status = 'done' AND file_path IS NOT NULL",
  );

  /** WHERE del historial; los valores van como parámetros (nunca concatenados). */
  const historyWhere = (filter: HistoryFilter) => {
    const where = [`type IN (${filter.types.map(() => '?').join(', ')})`];
    const args: string[] = [...filter.types];
    if (filter.userId !== null) {
      where.push('user_id = ?');
      args.push(filter.userId);
    }
    const search = filter.search === null ? '' : normalizeSearchText(filter.search);
    if (search !== '') {
      where.push("title_search LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(search)}%`);
    }
    // ISO en UTC con el mismo formato: se comparan como texto.
    if (filter.from) {
      where.push('created_at >= ?');
      args.push(filter.from);
    }
    if (filter.to) {
      where.push('created_at < ?');
      args.push(filter.to);
    }
    if (filter.requester) {
      where.push(`${REQUESTER_SQL} = ?`);
      args.push(filter.requester);
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
        userId: job.userId ?? null,
        notifyUserIds: JSON.stringify(job.notifyUserIds ?? []),
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

    listExpirable(beforeIso) {
      return expirableStmt.all(beforeIso).map((row) => ({ id: row.id, filePath: row.file_path }));
    },

    countActiveByUser(userId) {
      const counts: Partial<Record<JobType, number>> = {};
      for (const row of activeByUserStmt.all(userId)) {
        counts[jobTypeSchema.parse(row.kind)] = row.total;
      }
      return counts;
    },

    setClientHost(id, host) {
      setClientHostStmt.run(host, id);
    },

    listRequesters(types) {
      if (types.length === 0) return [];
      return db
        .prepare<string[], { value: string; total: number }>(
          `SELECT ${REQUESTER_SQL} AS value, COUNT(*) AS total
             FROM jobs
            WHERE type IN (${types.map(() => '?').join(', ')})
              AND ${REQUESTER_SQL} IS NOT NULL
            GROUP BY value
            ORDER BY MAX(created_at) DESC
            LIMIT 200`,
        )
        .all(...types);
    },

    setFollowUp(id, followUpJobId) {
      return setFollowUpStmt.run(followUpJobId, id).changes === 1;
    },

    listLiveFilePaths() {
      return liveFilePathsStmt.all().map((row) => row.file_path);
    },
  };
}
