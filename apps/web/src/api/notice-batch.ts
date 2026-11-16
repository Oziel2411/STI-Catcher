import { createNoticeBatchResponseSchema } from '@sti-catcher/shared';
import { z } from 'zod';
import { apiPost } from './client.ts';

/**
 * Aviso agrupado (D-105): si se piden varios trabajos de una vez y hay a quién
 * avisar, se abre un pedido para que llegue un solo mail cuando terminen todos.
 * `create` recibe el id del pedido (o null) y crea los trabajos; al final el
 * pedido se cierra aunque algo haya fallado.
 *
 * Si no se puede abrir el pedido, cada trabajo avisa solo, como antes.
 */
export async function withNoticeBatch(
  notify: readonly string[],
  count: number,
  create: (batchId: string | null) => Promise<void>,
): Promise<void> {
  let batchId: string | null = null;
  if (notify.length > 0 && count > 1) {
    try {
      ({ batchId } = await apiPost('/api/notice-batches', createNoticeBatchResponseSchema, {
        notify,
      }));
    } catch {
      batchId = null;
    }
  }
  try {
    await create(batchId);
  } finally {
    if (batchId !== null) {
      // Si no se pudo cerrar, el servidor lo cierra solo al rato.
      await apiPost(`/api/notice-batches/${batchId}/close`, z.null()).catch(() => null);
    }
  }
}
