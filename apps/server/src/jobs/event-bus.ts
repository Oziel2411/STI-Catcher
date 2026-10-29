import { eventJobId } from '@sti-catcher/shared';
import type { JobEvent } from '@sti-catcher/shared';

export type JobEventListener = (event: JobEvent) => void;

export type JobEventBus = {
  publish(event: JobEvent): void;
  /**
   * @param jobIds si se indica, solo recibe eventos de esos jobs
   * @returns función para desuscribirse
   */
  subscribe(listener: JobEventListener, jobIds?: ReadonlySet<string>): () => void;
  listenerCount(): number;
};

/**
 * Bus de eventos de jobs, en memoria. Única fuente de los streams SSE:
 * `/api/events` y `/api/jobs/:id/events` son suscripciones filtradas (D-021).
 *
 * Un listener que lanza no afecta a los demás ni a quien publica.
 */
export function createJobEventBus(onListenerError?: (error: unknown) => void): JobEventBus {
  const listeners = new Map<JobEventListener, ReadonlySet<string> | undefined>();

  return {
    publish(event) {
      const jobId = eventJobId(event);
      for (const [listener, filter] of listeners) {
        if (filter && !filter.has(jobId)) continue;
        try {
          listener(event);
        } catch (error) {
          onListenerError?.(error);
        }
      }
    },
    subscribe(listener, jobIds) {
      listeners.set(listener, jobIds);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount() {
      return listeners.size;
    },
  };
}
