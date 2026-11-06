import type { Db } from './connection.ts';

export type RecordingStatus = 'recording' | 'finalized' | 'discarded';

export type RecordingSession = {
  id: string;
  status: RecordingStatus;
  mimeType: string;
  /** Extensión del archivo crudo (sin punto): "mp4" o "webm". */
  extension: string;
  fps: number;
  title: string;
  clientId: string | null;
  /** Cuenta que la empezó (D-100): solo ella manda fragmentos y la termina. */
  userId: string | null;
  clientIp: string | null;
  /** Próximo número de fragmento esperado. */
  nextSeq: number;
  sizeBytes: number;
  createdAt: string;
  lastChunkAt: string | null;
  jobId: string | null;
};

type Row = {
  id: string;
  status: RecordingStatus;
  mime_type: string;
  extension: string;
  fps: number;
  title: string;
  client_id: string | null;
  user_id: string | null;
  client_ip: string | null;
  next_seq: number;
  size_bytes: number;
  created_at: string;
  last_chunk_at: string | null;
  job_id: string | null;
};

const toSession = (row: Row): RecordingSession => ({
  id: row.id,
  status: row.status,
  mimeType: row.mime_type,
  extension: row.extension,
  fps: row.fps,
  title: row.title,
  clientId: row.client_id,
  userId: row.user_id,
  clientIp: row.client_ip,
  nextSeq: row.next_seq,
  sizeBytes: row.size_bytes,
  createdAt: row.created_at,
  lastChunkAt: row.last_chunk_at,
  jobId: row.job_id,
});

export type NewRecording = Pick<
  RecordingSession,
  'id' | 'mimeType' | 'extension' | 'fps' | 'title' | 'userId' | 'clientIp' | 'createdAt'
>;

export type RecordingsRepository = {
  insert(session: NewRecording): RecordingSession;
  get(id: string): RecordingSession | null;
  /** Registra el fragmento `seq` (solo si es el esperado y la sesión sigue abierta). */
  recordChunk(id: string, seq: number, bytes: number, at: string): boolean;
  /** recording → finalized con su job de procesamiento. */
  finalize(id: string, jobId: string): boolean;
  /** recording → discarded (sin datos). */
  discard(id: string): boolean;
  /** Sesiones abiertas sin fragmentos desde antes de `before` (ISO). */
  listIdle(before: string): RecordingSession[];
};

export function createRecordingsRepository(db: Db): RecordingsRepository {
  const insertStmt = db.prepare<[NewRecording]>(`
    INSERT INTO recordings (id, status, mime_type, extension, fps, title, user_id, client_ip, created_at)
    VALUES (@id, 'recording', @mimeType, @extension, @fps, @title, @userId, @clientIp, @createdAt)
  `);
  const getStmt = db.prepare<[string], Row>('SELECT * FROM recordings WHERE id = ?');
  const chunkStmt = db.prepare<[number, string, string, number]>(`
    UPDATE recordings
       SET next_seq = next_seq + 1, size_bytes = size_bytes + ?, last_chunk_at = ?
     WHERE id = ? AND next_seq = ? AND status = 'recording'
  `);
  const finalizeStmt = db.prepare<[string, string]>(
    "UPDATE recordings SET status = 'finalized', job_id = ? WHERE id = ? AND status = 'recording'",
  );
  const discardStmt = db.prepare<[string]>(
    "UPDATE recordings SET status = 'discarded' WHERE id = ? AND status = 'recording'",
  );
  const idleStmt = db.prepare<[string], Row>(`
    SELECT * FROM recordings
     WHERE status = 'recording' AND COALESCE(last_chunk_at, created_at) < ?
     ORDER BY created_at
  `);

  return {
    insert(session) {
      insertStmt.run(session);
      const row = getStmt.get(session.id);
      if (!row) throw new Error(`No se pudo leer la grabación recién creada ${session.id}`);
      return toSession(row);
    },
    get(id) {
      const row = getStmt.get(id);
      return row ? toSession(row) : null;
    },
    recordChunk(id, seq, bytes, at) {
      return chunkStmt.run(bytes, at, id, seq).changes === 1;
    },
    finalize(id, jobId) {
      return finalizeStmt.run(jobId, id).changes === 1;
    },
    discard(id) {
      return discardStmt.run(id).changes === 1;
    },
    listIdle(before) {
      return idleStmt.all(before).map(toSession);
    },
  };
}
