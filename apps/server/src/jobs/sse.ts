import type { JobEvent } from '@sti-catcher/shared';

/**
 * Formato Server-Sent Events: `event:` con el tipo y `data:` con el JSON.
 * JSON.stringify no produce saltos de línea, así que entra en una sola línea `data:`.
 */
export function formatSseEvent(event: JobEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Latido. Es un evento con nombre (`ping`) y no un comentario SSE porque el
 * cliente lo usa como watchdog: si deja de recibir latidos, reconecta. Los
 * comentarios no llegan a JavaScript.
 *
 * Hace falta porque un proxy (el de Vite en desarrollo, medido) puede dejar
 * abierta la conexión con el navegador aunque el server de atrás haya muerto:
 * EventSource no se entera y no reconecta nunca.
 */
export const SSE_HEARTBEAT = 'event: ping\ndata: {}\n\n';
export const SSE_HEARTBEAT_EVENT = 'ping';

/** Le indica al navegador cuánto esperar antes de reconectar si se corta. */
export const SSE_RETRY = 'retry: 3000\n\n';

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  // Por si en el futuro hay un proxy delante (nginx): que no acumule los eventos.
  'x-accel-buffering': 'no',
  // Sin 'connection: keep-alive': está prohibido en HTTP/2 y en HTTP/1.1 ya es el default.
} as const;
