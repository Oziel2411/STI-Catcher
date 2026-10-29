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
  clientId: string | null;
  parentJobId: string | null;
};

export type NewJob = Pick<JobRecord, 'id' | 'type' | 'params' | 'createdAt'> &
  Partial<Pick<JobRecord, 'sourceUrl' | 'title' | 'clientIp' | 'clientId' | 'parentJobId'>>;

export type FinalStatus = Extract<JobStatus, 'done' | 'failed' | 'cancelled'>;

/** Datos que se guardan al terminar un job. */
export type JobFinish = {
  status: FinalStatus;
  finishedAt: string;
  error?: string | null;
  filePath?: string | null;
  sizeBytes?: number | null;
  durationSeconds?: number | null;
  title?: string | null;
};

export type ListJobsFilter = {
  statuses?: readonly JobStatus[];
  types?: readonly JobType[];
  limit: number;
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
};

/** Resultado de un runner exitoso. */
export type JobResult = {
  /**
   * Archivo final dentro de la carpeta temporal. La cola lo mueve a
   * `STORAGE_DIR/files/<id><extension>`. null si el job no produce archivo.
   */
  output: { tempPath: string; extension: string } | null;
  metadata?: {
    title?: string | null;
    sizeBytes?: number | null;
    durationSeconds?: number | null;
  };
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
