import { randomUUID } from 'node:crypto';
import type { NoticeBatchesRepository } from '../../db/notice-batches-repository.ts';

/** Error con mensaje para el usuario y el código HTTP que corresponde. */
export class NoticeBatchError extends Error {
  override name = 'NoticeBatchError';
  constructor(
    readonly code: 'BATCH_NOT_FOUND' | 'BATCH_CLOSED',
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

export type NoticeBatchServiceDeps = {
  repo: NoticeBatchesRepository;
  /** Al cerrar: si ya terminaron todos, sale el mail (D-105). */
  onClosed: (batchId: string) => void;
  now?: () => Date;
};

/**
 * Pedidos con aviso agrupado (D-105). La web abre uno antes de crear varios
 * trabajos de una vez, manda su id en cada trabajo y lo cierra al terminar de
 * crearlos. Un pedido es de quien lo abrió: otra cuenta no puede usarlo.
 */
export function createNoticeBatchService(deps: NoticeBatchServiceDeps) {
  const now = deps.now ?? (() => new Date());

  /** El pedido existe, es de esa cuenta y sigue abierto. */
  const assertOpen = (batchId: string, userId: string) => {
    const batch = deps.repo.get(batchId);
    // De otra cuenta = no existe: no se confirma que el id sea válido.
    if (batch?.userId !== userId) {
      throw new NoticeBatchError('BATCH_NOT_FOUND', 'El pedido no existe.', 404);
    }
    if (batch.closedAt !== null) {
      throw new NoticeBatchError(
        'BATCH_CLOSED',
        'El pedido ya se cerró: volvé a pedir los trabajos.',
        409,
      );
    }
  };

  return {
    create(userId: string, notifyUserIds: string[]): string {
      const id = randomUUID();
      deps.repo.insert({ id, userId, notifyUserIds, createdAt: now().toISOString() });
      return id;
    },

    assertOpen,

    /** Idempotente: cerrar dos veces no es un error. */
    close(batchId: string, userId: string): void {
      const batch = deps.repo.get(batchId);
      if (batch?.userId !== userId) {
        throw new NoticeBatchError('BATCH_NOT_FOUND', 'El pedido no existe.', 404);
      }
      if (deps.repo.close(batchId, now().toISOString())) deps.onClosed(batchId);
    },
  };
}

export type NoticeBatchService = ReturnType<typeof createNoticeBatchService>;
