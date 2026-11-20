import { stat } from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_JOB_TYPES, isActiveStatus } from '@sti-catcher/shared';
import type {
  ActiveJobsResponse,
  HistoryBulkDeleteResponse,
  HistoryItem,
  HistoryRequestersResponse,
  HistoryResponse,
  HistoryScope,
  Job,
  JobType,
  TrashEmptyResponse,
  TrashItem,
  TrashResponse,
} from '@sti-catcher/shared';
import { normalizeIp } from '../../adapters/host-resolver.ts';
import type { EnqueueInput, JobQueue } from '../../jobs/queue.ts';
import type { JobRecord, JobsRepository, TrashKind } from '../../jobs/types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tipos que aparecen en el historial. El selftest no: es una prueba del sistema (D-030). */
export const HISTORY_TYPES: readonly JobType[] = HISTORY_JOB_TYPES;

/** Prefijo de los valores del filtro Usuario que son una cuenta (ver REQUESTER_SQL). */
const USER_PREFIX = 'user:';

/** Tipos que se pueden reintentar con los mismos parámetros. */
const RETRYABLE_TYPES: readonly JobType[] = [
  'download',
  'conversion',
  'compression',
  'edit',
  'recording',
];

/** Error con mensaje para el usuario; las rutas lo traducen al código HTTP. */
export class HistoryError extends Error {
  override name = 'HistoryError';
  constructor(
    readonly code:
      | 'JOB_NOT_FOUND'
      | 'NOT_OWNER'
      | 'JOB_ACTIVE'
      | 'NOT_RETRYABLE'
      | 'NO_FILE'
      | 'SOURCE_IN_USE'
      | 'NOT_IN_TRASH',
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
  }
}

/**
 * Quién hace el pedido: la cuenta (D-104) y la IP. `userId` es null solo para
 * una conversión encadenada a una descarga de antes del login.
 */
export type Requester = { userId: string | null; ip: string | null };

export type HistoryServiceDeps = {
  repo: Pick<
    JobsRepository,
    | 'get'
    | 'listHistory'
    | 'countActiveByUser'
    | 'listRequesters'
    | 'hasActiveChildren'
    | 'listTrash'
    | 'listTrashedBefore'
  >;
  queue: Pick<JobQueue, 'toApi' | 'expire' | 'rename' | 'enqueue' | 'trash' | 'restore' | 'purge'>;
  storageDir: string;
  filesDir: string;
  /** Papelera (D-115): STORAGE_DIR\trash. */
  trashDir: string;
  /** Días que se guarda lo borrado (TRASH_DAYS). */
  trashDays: number;
  removeFile: (filePath: string) => Promise<void>;
  moveFile: (from: string, to: string) => Promise<void>;
  now?: () => Date;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
  /** Nombre de cada cuenta (columna Usuario del historial). */
  userNames: (ids: readonly string[]) => Map<string, string>;
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
  /** Manda el trabajo y su archivo a la papelera (D-115): deja de verse en el historial. */
  remove: (id: string, requester: Requester) => Promise<void>;
  /** Manda solo el archivo a la papelera: el trabajo queda `expired` (D-113, D-115). */
  removeFile: (id: string, requester: Requester) => Promise<Job>;
  /** La papelera de quien pide (D-115). */
  trash: (requester: Requester) => TrashResponse;
  restoreMany: (ids: readonly string[], requester: Requester) => Promise<HistoryBulkDeleteResponse>;
  /** Borrar para siempre desde la papelera. */
  purgeMany: (ids: readonly string[], requester: Requester) => Promise<HistoryBulkDeleteResponse>;
  emptyTrash: (requester: Requester) => Promise<TrashEmptyResponse>;
  /** Lo que lleva más de TRASH_DAYS en la papelera se borra para siempre (retención). */
  purgeExpiredTrash: () => Promise<number>;
  /** Varios de una vez; los que no se pueden quedan en `failed` con el motivo (D-113). */
  removeMany: (
    ids: readonly string[],
    what: 'file' | 'job',
    requester: Requester,
  ) => Promise<HistoryBulkDeleteResponse>;
  /** Cambia el título de un trabajo propio que no está en curso (D-113). */
  rename: (id: string, title: string, requester: Requester) => Job;
  retry: (id: string, requester: Requester) => Promise<Job>;
  /** Contadores de la barra lateral: lo que este navegador tiene en cola o en curso. */
  activeCounts: (requester: Requester) => ActiveJobsResponse;
};

/**
 * Historial (SPEC §8): listado paginado con búsqueda, borrado de trabajos
 * propios y reintento de los que fallaron.
 *
 * "Propio" = creado con la misma cuenta (D-104). Los trabajos de antes del
 * login no son de nadie: nadie los borra desde la UI.
 */
export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const filesRoot = path.resolve(deps.filesDir) + path.sep;
  const trashRoot = path.resolve(deps.trashDir) + path.sep;
  const now = deps.now ?? (() => new Date());

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

  const isOwn = (record: JobRecord, requester: Requester) =>
    record.userId !== null && record.userId === requester.userId;

  /** Usuario del historial: el nombre de la cuenta; en los viejos, la PC o la IP (D-098). */
  const requesterLabel = (record: JobRecord, names: Map<string, string>): string | null => {
    if (record.userId !== null) return names.get(record.userId) ?? 'Cuenta borrada';
    return record.clientHost ?? (record.clientIp === null ? null : normalizeIp(record.clientIp));
  };

  const toItem = (
    record: JobRecord,
    requester: Requester,
    names: Map<string, string>,
  ): HistoryItem => ({
    ...deps.queue.toApi(record),
    isMine: isOwn(record, requester),
    // Una consulta por item con origen (a lo sumo una página): más simple que un JOIN.
    parentTitle:
      record.parentJobId === null ? null : (deps.repo.get(record.parentJobId)?.title ?? null),
    requester: requesterLabel(record, names),
  });

  const getOrThrow = (id: string): JobRecord => {
    const record = deps.repo.get(id);
    if (!record || !HISTORY_TYPES.includes(record.type) || record.trashKind === 'job') {
      throw new HistoryError('JOB_NOT_FOUND', 'No existe ese trabajo.', 404);
    }
    return record;
  };

  /** Un trabajo propio, terminado, cuyo archivo no está leyendo otro trabajo en curso. */
  const deletable = (id: string, requester: Requester): JobRecord => {
    const record = getOrThrow(id);
    if (!isOwn(record, requester)) {
      throw new HistoryError('NOT_OWNER', 'Solo podés borrar los trabajos que creaste vos.', 403);
    }
    if (isActiveStatus(record.status)) {
      throw new HistoryError(
        'JOB_ACTIVE',
        'El trabajo está en curso: cancelalo antes de borrarlo.',
        409,
      );
    }
    // Una conversión o compresión en cola lee este archivo: borrarlo la haría fallar.
    if (deps.repo.hasActiveChildren(id)) {
      throw new HistoryError(
        'SOURCE_IN_USE',
        'Una conversión o compresión en curso usa este archivo: esperá a que termine.',
        409,
      );
    }
    return record;
  };

  /**
   * Manda un trabajo a la papelera (D-115). Su archivo pasa de files/ a trash/
   * (no se borra) y el trabajo queda `expired` hasta que se restaure. Con
   * 'job' además deja de verse en el historial.
   */
  const moveToTrash = async (
    id: string,
    kind: TrashKind,
    requester: Requester,
  ): Promise<JobRecord> => {
    const record = deletable(id, requester);
    const file = record.status === 'done' ? absoluteFile(record) : null;
    const hasFile = file !== null && (await fileExists(file));
    if (kind === 'file' && !hasFile) {
      // done sin archivo en disco: lo borró alguien a mano. Queda expirado, como al mirarlo.
      if (record.status === 'done') deps.queue.expire(id);
      throw new HistoryError('NO_FILE', 'Este trabajo ya no tiene un archivo para borrar.', 409);
    }
    let trashPath: string | null = null;
    if (file !== null && hasFile) {
      const saved = path.join(deps.trashDir, path.basename(file));
      // Primero el archivo: si no se puede mover, el trabajo sigue como estaba.
      await deps.moveFile(file, saved);
      trashPath = path.relative(deps.storageDir, saved);
    }
    if (!deps.queue.trash(id, { kind, at: now().toISOString(), trashPath })) {
      // Empezó a correr entre la consulta y ahora (reintento): el archivo vuelve.
      if (file !== null && trashPath !== null) {
        await deps.moveFile(path.resolve(deps.storageDir, trashPath), file);
      }
      throw new HistoryError(
        'JOB_ACTIVE',
        'El trabajo está en curso: cancelalo antes de borrarlo.',
        409,
      );
    }
    // SPEC §8: los borrados quedan en el log con la IP.
    deps.logger.info(
      {
        jobId: id,
        type: record.type,
        title: record.title,
        what: kind,
        deletedByUser: requester.userId,
        deletedByIp: requester.ip,
        createdByUser: record.userId,
        createdByIp: record.clientIp,
      },
      kind === 'job' ? 'Trabajo movido a la papelera' : 'Archivo movido a la papelera',
    );
    return deps.repo.get(id) ?? record;
  };

  const remove = async (id: string, requester: Requester): Promise<void> => {
    await moveToTrash(id, 'job', requester);
  };

  const removeFile = async (id: string, requester: Requester): Promise<Job> =>
    deps.queue.toApi(await moveToTrash(id, 'file', requester));

  /** Un trabajo propio que está en la papelera. */
  const trashedOrThrow = (id: string, requester: Requester): JobRecord => {
    const record = deps.repo.get(id);
    if (!record || record.trashKind === null) {
      throw new HistoryError('NOT_IN_TRASH', 'Ese trabajo no está en la papelera.', 404);
    }
    if (!isOwn(record, requester)) {
      throw new HistoryError('NOT_OWNER', 'Solo podés tocar tu papelera.', 403);
    }
    return record;
  };

  /** Archivo guardado en la papelera, solo si queda dentro de STORAGE_DIR/trash. */
  const trashFile = (record: JobRecord): string | null => {
    if (record.trashPath === null) return null;
    const absolute = path.resolve(deps.storageDir, record.trashPath);
    return absolute.startsWith(trashRoot) ? absolute : null;
  };

  /** Borra para siempre: el archivo guardado y, si era 'job', la fila. Devuelve lo liberado. */
  const purgeRecord = async (record: JobRecord): Promise<number> => {
    const file = trashFile(record);
    const freed = file !== null && (await fileExists(file)) ? (record.sizeBytes ?? 0) : 0;
    if (file !== null) await deps.removeFile(file);
    deps.queue.purge(record.id);
    return freed;
  };

  const purge = async (id: string, requester: Requester): Promise<void> => {
    const record = trashedOrThrow(id, requester);
    await purgeRecord(record);
    deps.logger.info(
      { jobId: id, title: record.title, purgedByUser: requester.userId, purgedByIp: requester.ip },
      'Borrado para siempre desde la papelera',
    );
  };

  const restore = async (id: string, requester: Requester): Promise<void> => {
    const record = trashedOrThrow(id, requester);
    const saved = trashFile(record);
    const target = absoluteFile(record);
    let fileBack = false;
    if (saved !== null && target !== null && (await fileExists(saved))) {
      await deps.moveFile(saved, target);
      fileBack = true;
    }
    deps.queue.restore(id, { at: now().toISOString(), fileBack });
    deps.logger.info(
      { jobId: id, title: record.title, fileBack, restoredByUser: requester.userId },
      'Restaurado de la papelera',
    );
  };

  /** De a uno: cada uno revisa sus reglas, y uno que no se puede no frena al resto. */
  const forEach = async (
    ids: readonly string[],
    action: (id: string) => Promise<unknown>,
  ): Promise<HistoryBulkDeleteResponse> => {
    const result: HistoryBulkDeleteResponse = { done: [], failed: [] };
    for (const id of new Set(ids)) {
      try {
        await action(id);
        result.done.push(id);
      } catch (error) {
        if (!(error instanceof HistoryError)) throw error;
        result.failed.push({ id, message: error.message });
      }
    }
    return result;
  };

  const toTrashItem = (
    record: JobRecord,
    requester: Requester,
    names: Map<string, string>,
  ): TrashItem => {
    const trashedAt = record.trashedAt ?? now().toISOString();
    return {
      ...toItem(record, requester, names),
      trashKind: record.trashKind ?? 'job',
      trashedAt,
      purgeAt: new Date(new Date(trashedAt).getTime() + deps.trashDays * DAY_MS).toISOString(),
      trashBytes: record.trashPath === null ? null : (record.sizeBytes ?? 0),
    };
  };

  return {
    async list({ scope, q, from, to, type, user, page, pageSize }, requester) {
      const { records, total } = deps.repo.listHistory({
        types:
          type && type.length > 0 ? type.filter((t) => HISTORY_TYPES.includes(t)) : HISTORY_TYPES,
        userId: scope === 'mine' ? (requester.userId ?? '') : null,
        search: q ?? null,
        from: from ?? null,
        to: to ?? null,
        requester: user ?? null,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      const reconciled = await Promise.all(records.map(reconcile));
      const names = deps.userNames(
        reconciled.flatMap((record) => (record.userId === null ? [] : [record.userId])),
      );
      return {
        items: reconciled.map((record) => toItem(record, requester, names)),
        total,
        page,
        pageSize,
      };
    },

    remove,
    removeFile,

    removeMany(ids, what, requester) {
      return forEach(ids, (id) => moveToTrash(id, what, requester));
    },

    trash(requester) {
      const records = requester.userId === null ? [] : deps.repo.listTrash(requester.userId);
      const names = deps.userNames(requester.userId === null ? [] : [requester.userId]);
      const items = records.map((record) => toTrashItem(record, requester, names));
      return {
        items,
        totalBytes: items.reduce((total, item) => total + (item.trashBytes ?? 0), 0),
        trashDays: deps.trashDays,
      };
    },

    restoreMany(ids, requester) {
      return forEach(ids, (id) => restore(id, requester));
    },

    purgeMany(ids, requester) {
      return forEach(ids, (id) => purge(id, requester));
    },

    async emptyTrash(requester) {
      if (requester.userId === null) return { purged: 0, freedBytes: 0 };
      let freedBytes = 0;
      const records = deps.repo.listTrash(requester.userId);
      for (const record of records) freedBytes += await purgeRecord(record);
      if (records.length > 0) {
        deps.logger.info(
          {
            purged: records.length,
            freedBytes,
            purgedByUser: requester.userId,
            purgedByIp: requester.ip,
          },
          'Papelera vaciada',
        );
      }
      return { purged: records.length, freedBytes };
    },

    async purgeExpiredTrash() {
      const cutoff = new Date(now().getTime() - deps.trashDays * DAY_MS).toISOString();
      let purged = 0;
      for (const record of deps.repo.listTrashedBefore(cutoff)) {
        // Si no se pudo borrar (archivo abierto), se reintenta en la próxima pasada.
        try {
          await purgeRecord(record);
          purged++;
        } catch (error) {
          deps.logger.warn(
            { err: error, jobId: record.id },
            'Papelera: no se pudo borrar un trabajo vencido',
          );
        }
      }
      return purged;
    },

    rename(id, title, requester) {
      const record = getOrThrow(id);
      if (!isOwn(record, requester)) {
        throw new HistoryError(
          'NOT_OWNER',
          'Solo podés cambiar el título de los trabajos que creaste vos.',
          403,
        );
      }
      const job = isActiveStatus(record.status) ? null : deps.queue.rename(id, title);
      if (job === null) {
        throw new HistoryError(
          'JOB_ACTIVE',
          'El trabajo está en curso: esperá a que termine para cambiarle el título.',
          409,
        );
      }
      return job;
    },

    requesters() {
      const rows = deps.repo.listRequesters(HISTORY_TYPES);
      const names = deps.userNames(
        rows.flatMap(({ value }) =>
          value.startsWith(USER_PREFIX) ? [value.slice(USER_PREFIX.length)] : [],
        ),
      );
      return {
        requesters: rows.map(({ value, total }) => ({
          value,
          label: value.startsWith(USER_PREFIX)
            ? (names.get(value.slice(USER_PREFIX.length)) ?? 'Cuenta borrada')
            : normalizeIp(value),
          total,
        })),
      };
    },

    activeCounts(requester) {
      if (requester.userId === null) {
        return { download: 0, conversion: 0, compression: 0, recording: 0 };
      }
      const counts = deps.repo.countActiveByUser(requester.userId);
      return {
        download: counts.download ?? 0,
        conversion: counts.conversion ?? 0,
        compression: counts.compression ?? 0,
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
        userId: requester.userId,
        // Reintentar avisa a los mismos que el original (D-104).
        notifyUserIds: record.notifyUserIds,
        clientIp: requester.ip,
      };
      return deps.queue.enqueue(input);
    },
  };
}
