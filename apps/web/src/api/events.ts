import { JOB_EVENT_TYPES, jobEventSchema } from '@sti-catcher/shared';
import type { JobEvent } from '@sti-catcher/shared';

export type JobEventHandlers = {
  onEvent: (event: JobEvent) => void;
  /** Cambió el estado de la conexión (para avisar en la UI). */
  onConnectionChange?: (connected: boolean) => void;
};

/** Lo mínimo de EventSource que se usa; permite pasar uno falso en los tests. */
export type EventSourceLike = {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};

export type SubscribeOptions = {
  /** Espera antes de reabrir una conexión que el navegador dio por cerrada. */
  retryMs?: number;
  /**
   * Si pasa este tiempo sin recibir nada (ni el latido que el server manda
   * cada 10 s), se da la conexión por muerta y se abre otra.
   */
  staleAfterMs?: number;
  createSource?: (url: string) => EventSourceLike;
};

const CLOSED = 2; // EventSource.CLOSED (no existe en Node, donde corren los tests)
/** Nombre del evento de latido del server (SSE_HEARTBEAT en apps/server). */
const HEARTBEAT_EVENT = 'ping';

/**
 * Se suscribe al stream SSE de un job y valida cada evento con el esquema de shared.
 *
 * Reconexión. EventSource no alcanza en dos casos, ambos medidos:
 * - Si recibe una respuesta HTTP de error (p. ej. 502 del proxy mientras el
 *   server reinicia), se cierra para siempre. Se abre otra después de `retryMs`.
 * - Si hay un proxy en el medio y el server muere, el proxy puede dejar la
 *   conexión abierta sin datos: EventSource no se entera. Un watchdog reconecta
 *   si pasan `staleAfterMs` sin recibir nada (el server manda latidos).
 * Al reconectar, el server manda primero el estado actual del job, así que la
 * UI se pone al día sola (por ejemplo, "Interrumpido").
 *
 * El server cierra el stream cuando el job termina: quien llama tiene que
 * llamar a la función devuelta al ver el estado final.
 *
 * @returns función para cerrar la suscripción
 */
export function subscribeToJobEvents(
  jobId: string,
  handlers: JobEventHandlers,
  options: SubscribeOptions = {},
): () => void {
  return subscribeToStream(`/api/jobs/${encodeURIComponent(jobId)}/events`, handlers, options);
}

/**
 * Stream de varios jobs (el historial sigue los que están en curso). A
 * diferencia del de un job, el server no lo cierra solo.
 */
export function subscribeToJobsEvents(
  jobIds: readonly string[],
  handlers: JobEventHandlers,
  options: SubscribeOptions = {},
): () => void {
  const query = jobIds.map(encodeURIComponent).join(',');
  return subscribeToStream(`/api/events?jobIds=${query}`, handlers, options);
}

function subscribeToStream(
  url: string,
  handlers: JobEventHandlers,
  {
    retryMs = 3000,
    staleAfterMs = 25_000,
    createSource = (sourceUrl) => new EventSource(sourceUrl),
  }: SubscribeOptions = {},
): () => void {
  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** Cada señal de vida del server posterga el watchdog. */
  const armWatchdog = () => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      handlers.onConnectionChange?.(false);
      dispose();
      connect();
    }, staleAfterMs);
  };

  const onHeartbeat = () => {
    armWatchdog();
  };

  const onMessage = (message: Event) => {
    armWatchdog();
    if (!(message instanceof MessageEvent) || typeof message.data !== 'string') return;
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    const parsed = jobEventSchema.safeParse(data);
    if (parsed.success) handlers.onEvent(parsed.data);
  };
  const onOpen = () => {
    armWatchdog();
    handlers.onConnectionChange?.(true);
  };
  const onError = () => {
    handlers.onConnectionChange?.(false);
    if (source?.readyState === CLOSED && !stopped) {
      dispose();
      retryTimer = setTimeout(connect, retryMs);
    }
  };

  function dispose() {
    clearTimeout(staleTimer);
    if (!source) return;
    for (const type of JOB_EVENT_TYPES) source.removeEventListener(type, onMessage);
    source.removeEventListener(HEARTBEAT_EVENT, onHeartbeat);
    source.removeEventListener('open', onOpen);
    source.removeEventListener('error', onError);
    source.close();
    source = null;
  }

  function connect() {
    if (stopped) return;
    source = createSource(url);
    for (const type of JOB_EVENT_TYPES) source.addEventListener(type, onMessage);
    source.addEventListener(HEARTBEAT_EVENT, onHeartbeat);
    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    // También cubre una conexión que nunca llega a abrir.
    armWatchdog();
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    dispose();
  };
}
