import { stat } from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_JOB_TYPES, isActiveStatus } from '@sti-catcher/shared';
import type {
  ActiveJobsResponse,
  HistoryItem,
  HistoryRequestersResponse,
  HistoryResponse,
  HistoryScope,
  Job,
  JobType,
} from '@sti-catcher/shared';
import { normalizeIp } from '../../adapters/host-resolver.ts';
import type { EnqueueInput, JobQueue } from '../../jobs/queue.ts';
import type { JobRecord, JobsRepository } from '../../jobs/types.ts';

/** Tipos que aparecen en el historial. El selftest no: es una prueba del sistema (D-030). */
export const HISTORY_TYPES: readonly JobType[] = HISTORY_JOB_TYPES;

/** Tipos que se pueden reintentar con los mismos parámetros. */
const RETRYABLE_TYPES: readonly JobType[] = ['download', 'conversion', 'recording'];

/** Error con mensaje para el usuario; las rutas lo traducen al código HTTP. */
export class HistoryError extends Error {
  override name = 'HistoryError';
  constructor(
    readonly code: 'JOB_NOT_FOUND' | 'NOT_OWNER' | 'JOB_ACTIVE' | 'NOT_RETRYABLE',
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
  }
}

/** Quién hace el pedido: navegador (cookie anónima) e IP. */
export type Requester = { clientId: string; ip: string | null };

export type HistoryServiceDeps = {
  repo: Pick<JobsRepository, 'get' | 'listHistory' | 'countActiveByClient' | 'listRequesters'>;
  queue: Pick<JobQueue, 'toApi' | 'expire' | 'remove' | 'enqueue'>;
  storageDir: string;
  filesDir: string;
  removeFile: (filePath: string) => Promise<void>;
  logger: { info: (obj: object, msg: string) => void };
  /** true si el archivo existe (inyectable para tests). */
  fileExists?: (filePath: string) => Promise<boolean>;
};

const defaultFileExists = async (filePath: string) => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

export type HistoryService = {
  list: (
    query: {
      scope: HistoryScope;
      q?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      type?: readonly JobType[] | undefined;
      user?: string | undefined;
      page: number;
      pageSize: number;
    },
    requester: Requester,
  ) => Promise<HistoryResponse>;
  /** Valores del filtro "Usuario". */
  requesters: () => HistoryRequestersResponse;
  remove: (id: string, requester: Requester) => Promise<void>;
  retry: (id: string, requester: Requester) => Promise<Job>;
  /** Contadores de la barra lateral: lo que este navegador tiene en cola o en curso. */
  activeCounts: (requester: Requester) => ActiveJobsResponse;
};

/**
 * Historial (SPEC §8): listado paginado con búsqueda, borrado de trabajos
 * propios y reintento de los que fallaron.
 *
 * "Propio" = creado desde el mismo navegador (cookie anónima). No es
 * seguridad, la cookie se puede falsificar: es prevención de accidentes.
 */
export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const filesRoot = path.resolve(deps.filesDir) + path.sep;

  /** Ruta absoluta del archivo de un job, solo si queda dentro de STORAGE_DIR/files. */
  const absoluteFile = (record: JobRecord): string | null => {
    if (record.filePath === null) return null;
    const absolute = path.resolve(deps.storageDir, record.filePath);
    return absolute.startsWith(filesRoot) ? absolute : null;
  };

  /**
   * Si el archivo de un job terminado ya no está (retención, borrado a mano),
   * pasa a `expired` en vez de dejar un link roto (SPEC §8).
   */
  const reconcile = async (record: JobRecord): Promise<JobRecord> => {
    if (record.status !== 'done') return record;
    const file = absoluteFile(record);
    if (file !== null && (await fileExists(file))) return record;
    deps.queue.expire(record.id);
    return { ...record, status: 'expired' };
  };

  const toItem = (record: JobRecord, requester: Requester): HistoryItem => ({
    ...deps.queue.toApi(record),
    isMine: record.clientId !== null && record.clientId === requester.clientId,
    // Una consulta por item con origen (a lo sumo una página): más simple que un JOIN.
    parentTitle:
      record.parentJobId === null ? null : (deps.repo.get(record.parentJobId)?.title ?? null),
    requester:
      record.clientHost ?? (record.clientIp === null ? null : normalizeIp(record.clientIp)),
  });

  const getOrThrow = (id: string): JobRecord => {
    const record = deps.repo.get(id);
    if (!record || !HISTORY_TYPES.includes(record.type)) {
      throw new HistoryError('JOB_NOT_FOUND', 'No existe ese trabajo.', 404);
    }
    return record;
  };

  return {
    async list({ scope, q, from, to, type, user, page, pageSize }, requester) {
      const { records, total } = deps.repo.listHistory({
        types:
          type && type.length > 0 ? type.filter((t) => HISTORY_TYPES.includes(t)) : HISTORY_TYPES,
        clientId: scope === 'mine' ? requester.clientId : null,
        search: q ?? null,
        from: from ?? null,
        to: to ?? null,
        requester: user ?? null,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      const reconciled = await Promise.all(records.map(reconcile));
      return {
        items: reconciled.map((record) => toItem(record, requester)),
        total,
        page,
        pageSize,
      };
    },

    async remove(id, requester) {
      const record = getOrThrow(id);
      if (record.clientId !== requester.clientId) {
        throw new HistoryError(
          'NOT_OWNER',
          'Solo podés borrar los trabajos que creaste desde este navegador.',
          403,
        );
      }
      if (isActiveStatus(record.status)) {
        throw new HistoryError(
          'JOB_ACTIVE',
          'El trabajo está en curso: cancelalo antes de borrarlo.',
          409,
        );
      }
      const file = absoluteFile(record);
      if (file !== null) await deps.removeFile(file);
      deps.queue.remove(id);
      // SPEC §8: los borrados quedan en el log con la IP.
      deps.logger.info(
        {
          jobId: id,
          type: record.type,
          title: record.title,
          deletedByIp: requester.ip,
          deletedByClient: requester.clientId,
          createdByIp: record.clientIp,
        },
        'Trabajo borrado del historial',
      );
    },

    requesters() {
      return {
        requesters: deps.repo.listRequesters(HISTORY_TYPES).map(({ value, total }) => ({
          value,
          label: normalizeIp(value),
          total,
        })),
      };
    },

    activeCounts(requester) {
      const counts = deps.repo.countActiveByClient(requester.clientId);
      return {
        download: counts.download ?? 0,
        conversion: counts.conversion ?? 0,
        recording: counts.recording ?? 0,
      };
    },

    async retry(id, requester) {
      const record = getOrThrow(id);
      if (record.status !== 'failed' && record.status !== 'cancelled') {
        throw new HistoryError(
          'NOT_RETRYABLE',
          'Solo se pueden reintentar trabajos que fallaron o se cancelaron.',
          409,
        );
      }
      if (!RETRYABLE_TYPES.includes(record.type)) {
        throw new HistoryError(
          'NOT_RETRYABLE',
          'Este tipo de trabajo no se puede reintentar.',
          409,
        );
      }
      // Un trabajo nuevo con los mismos parámetros: el original queda en el historial tal cual.
      const input: EnqueueInput = {
        type: record.type,
        params: record.params,
        title: record.title,
        sourceUrl: record.sourceUrl,
        parentJobId: record.parentJobId,
        clientId: requester.clientId,
        clientIp: requester.ip,
      };
      return deps.queue.enqueue(input);
    },
  };
}
