import { eventsQuerySchema, isActiveStatus, jobIdParamsSchema } from '@sti-catcher/shared';
import type { JobEvent } from '@sti-catcher/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, parseInput } from '../http/validation.ts';
import type { JobEventBus } from '../jobs/event-bus.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { formatSseEvent, SSE_HEADERS, SSE_HEARTBEAT, SSE_RETRY } from '../jobs/sse.ts';

export type EventRoutesOptions = {
  queue: JobQueue;
  bus: JobEventBus;
  heartbeatMs?: number;
};

type StreamOptions = {
  bus: JobEventBus;
  filter: ReadonlySet<string> | undefined;
  /** Estado actual, para que el cliente no dependa de haber visto eventos anteriores. */
  initialEvents: JobEvent[];
  /** Si devuelve true, el server cierra el stream después de enviar ese evento. */
  endAfter?: (event: JobEvent) => boolean;
  heartbeatMs: number;
};

const isFinalUpdate = (event: JobEvent) =>
  event.type === 'job.updated' && !isActiveStatus(event.job.status);

/**
 * SSE (D-021). Los dos endpoints son suscripciones al mismo event bus; solo
 * cambia el filtro.
 * - `GET /api/events?jobIds=a,b`: el stream de una pestaña.
 * - `GET /api/jobs/:id/events`: un solo job; se cierra cuando el job termina.
 */
export function registerEventRoutes(app: FastifyInstance, options: EventRoutesOptions): void {
  // El cliente reconecta si pasan 25 s sin nada (2,5 latidos): ver SSE_HEARTBEAT.
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const openStreams = new Set<() => void>();

  // Los streams no terminan solos: si no se cierran acá, app.close() esperaría para siempre.
  app.addHook('preClose', (done) => {
    for (const close of openStreams) close();
    done();
  });

  const openStream = (request: FastifyRequest, reply: FastifyReply, stream: StreamOptions) => {
    // A partir de acá la respuesta es nuestra: Fastify no la serializa ni la cierra.
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, SSE_HEADERS);

    // Estado mutable del stream; se cierra desde send(), el heartbeat o la desconexión.
    const state: {
      closed: boolean;
      unsubscribe: () => void;
      heartbeat: NodeJS.Timeout | undefined;
    } = { closed: false, unsubscribe: () => {}, heartbeat: undefined };

    const close = () => {
      if (state.closed) return;
      state.closed = true;
      state.unsubscribe();
      clearInterval(state.heartbeat);
      openStreams.delete(close);
      response.end();
    };
    const send = (event: JobEvent) => {
      if (state.closed) return;
      response.write(formatSseEvent(event));
      if (stream.endAfter?.(event)) close();
    };

    response.write(SSE_RETRY);
    for (const event of stream.initialEvents) send(event);
    if (state.closed) return;

    // Todo esto es sincrónico: entre el snapshot y la suscripción no se pierde ningún evento.
    state.unsubscribe = stream.bus.subscribe(send, stream.filter);
    state.heartbeat = setInterval(() => {
      if (!state.closed) response.write(SSE_HEARTBEAT);
    }, stream.heartbeatMs);
    openStreams.add(close);
    request.raw.once('close', close);
  };

  app.get('/api/events', (request, reply) => {
    const { jobIds } = parseInput(eventsQuerySchema, request.query);
    const filter = jobIds ? new Set(jobIds) : undefined;
    const initialEvents: JobEvent[] = (jobIds ?? []).flatMap((id) => {
      const job = options.queue.get(id);
      return job ? [{ type: 'job.updated' as const, job }] : [];
    });
    openStream(request, reply, { bus: options.bus, filter, initialEvents, heartbeatMs });
  });

  app.get('/api/jobs/:id/events', (request, reply) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    const job = options.queue.get(id);
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'No existe ese trabajo.');
    openStream(request, reply, {
      bus: options.bus,
      filter: new Set([id]),
      initialEvents: [{ type: 'job.updated', job }],
      endAfter: isFinalUpdate,
      heartbeatMs,
    });
  });
}
