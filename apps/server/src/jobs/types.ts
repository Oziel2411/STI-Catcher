import type { JobProgress, JobStatus, JobType } from '@sti-catcher/shared';

/** Un job tal como se guarda en la base. */
export type JobRecord = {
  id: string;
  type: JobType;
  status: JobStatus;
  /** Opciones del job; cada runner las valida con su esquema. */
  params: unknown;
  sourceUrl: string | null;
  title: string | null;
  format: string | null;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  /** Relativa a STORAGE_DIR. */
  filePath: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  clientIp: string | null;
  /** Cookie anónima de antes del login (D-041). Los trabajos nuevos no la tienen. */
  clientId: string | null;
  /** Cuenta que lo pidió (D-104). null en los trabajos de antes del login. */
  userId: string | null;
  /** Nombre de la PC (D-098); null mientras se resuelve o si no se encontró. */
  clientHost: string | null;
  parentJobId: string | null;
  /** Conversión encadenada a esta descarga (D-093). */
  followUpJobId: string | null;
};

export type NewJob = Pick<JobRecord, 'id' | 'type' | 'params' | 'createdAt'> &
  Partial<Pick<JobRecord, 'sourceUrl' | 'title' | 'clientIp' | 'userId' | 'parentJobId'>>;

export type FinalStatus = Extract<JobStatus, 'done' | 'failed' | 'cancelled'>;

/** Datos técnicos del resultado (de ffprobe). Todos opcionales: no todo job produce un archivo. */
export type JobMediaMetadata = {
  title?: string | null;
  sizeBytes?: number | null;
  durationSeconds?: number | null;
  format?: string | null;
  resolution?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
};

/** Datos que se guardan al terminar un job. */
export type JobFinish = JobMediaMetadata & {
  status: FinalStatus;
  finishedAt: string;
  error?: string | null;
  filePath?: string | null;
};

export type ListJobsFilter = {
  statuses?: readonly JobStatus[];
  types?: readonly JobType[];
  limit: number;
};

export type HistoryFilter = {
  /** Tipos que se muestran en el historial (el selftest no). */
  types: readonly JobType[];
  /** Solo los de esta cuenta; null = todos. */
  userId: string | null;
  /** Texto a buscar en el título (se normaliza sin tildes). */
  search: string | null;
  /** Creados desde (inclusive) / hasta (exclusive), ISO. */
  from?: string | null;
  to?: string | null;
  /** Quién lo pidió, como lo da listRequesters (`user:<id>`, o la PC o IP de los viejos). */
  requester?: string | null;
  limit: number;
  offset: number;
};

export type JobsRepository = {
  insert(job: NewJob): JobRecord;
  get(id: string): JobRecord | null;
  list(filter: ListJobsFilter): JobRecord[];
  /** El job queued más antiguo, o null. */
  nextQueued(): JobRecord | null;
  /** queued → running. false si el job ya no estaba queued (p. ej. lo cancelaron). */
  markRunning(id: string, startedAt: string): boolean;
  /** queued|running → estado final. false si el job ya había terminado. */
  finish(id: string, patch: JobFinish): boolean;
  /** Todos los running → failed con el mensaje dado. Devuelve los ids afectados. */
  failAllRunning(error: string, finishedAt: string): string[];
  countActive(): { queued: number; running: number };
  /** done → expired (el archivo ya no está). false si no estaba en done. */
  markExpired(id: string): boolean;
  /** Borra un job terminado. false si no existe o todavía está activo. */
  delete(id: string): boolean;
  listHistory(filter: HistoryFilter): { records: JobRecord[]; total: number };
  /**
   * Jobs `done` con archivo que terminaron antes de `beforeIso` (retención).
   * Excluye los que son origen de una conversión en cola o en curso.
   */
  listExpirable(beforeIso: string): { id: string; filePath: string }[];
  /**
   * Trabajos en cola o en curso de una cuenta, por tipo. Las conversiones
   * encadenadas a una descarga cuentan como 'download'.
   */
  countActiveByUser(userId: string): Partial<Record<JobType, number>>;
  /** Guarda el nombre de la PC que hizo el pedido. */
  setClientHost(id: string, host: string): void;
  /**
   * Quiénes pidieron trabajos de esos tipos, con cuántos trabajos, del más
   * reciente al más viejo: `user:<id>` para los de una cuenta; para los de
   * antes del login, el nombre de la PC (o la IP si no se resolvió).
   */
  listRequesters(types: readonly JobType[]): { value: string; total: number }[];
  /** Vincula la conversión encadenada. false si ya tenía una (no se pisa). */
  setFollowUp(id: string, followUpJobId: string): boolean;
  /** Rutas relativas (`files/<id>.<ext>`) de los archivos de jobs `done`. */
  listLiveFilePaths(): string[];
};

/** Resultado de un runner exitoso. */
export type JobResult = {
  /**
   * Archivo final dentro de la carpeta temporal. La cola lo mueve a
   * `STORAGE_DIR/files/<id><extension>`. null si el job no produce archivo.
   */
  output: { tempPath: string; extension: string } | null;
  metadata?: JobMediaMetadata;
};

export type JobContext = {
  job: JobRecord;
  /** Se aborta al cancelar el job o al detener el server. El runner debe cortar sus procesos. */
  signal: AbortSignal;
  /**
   * Carpeta temporal. El runner escribe ahí solo archivos que empiecen con el
   * id del job: la cola los borra si el job no termina bien.
   */
  tempDir: string;
  reportProgress: (progress: JobProgress) => void;
};

export type JobRunner = {
  run: (context: JobContext) => Promise<JobResult>;
};

export type { JobProgress };
