import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { ApiError } from '@sti-catcher/shared';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { HttpError } from './http/validation.ts';
import type { JobEventBus } from './jobs/event-bus.ts';
import type { JobQueue } from './jobs/queue.ts';
import type { HealthService } from './modules/health/health-service.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerJobRoutes } from './routes/jobs.ts';

export type AppServices = {
  health: HealthService;
  jobs: JobQueue;
  events: JobEventBus;
};

export type BuildAppOptions = {
  logger: Logger;
  services: AppServices;
  /** Carpeta con el build de la web. Si es null no se sirve (en desarrollo lo hace Vite). */
  webDistDir: string | null;
  /** HTTPS + HTTP/2. null = HTTP/1.1 sin cifrar (solo localhost). */
  https: { cert: Buffer; key: Buffer } | null;
  /** Intervalo del heartbeat SSE (los tests lo achican). */
  sseHeartbeatMs?: number;
};

const apiError = (
  code: string,
  message: string,
  issues?: ApiError['error']['issues'],
): ApiError => ({
  error: issues ? { code, message, issues } : { code, message },
});

/**
 * Construye la app sin ponerla a escuchar, para poder usarla en tests con `inject`.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  // Sin anotar el tipo: FastifyServerOptions está atado a HTTP/1 y rompe la sobrecarga de HTTP/2.
  const base = {
    loggerInstance: options.logger,
    routerOptions: { ignoreTrailingSlash: true },
  };

  // Con HTTPS se habilita HTTP/2 (con fallback a HTTP/1.1): el límite de 6
  // conexiones simultáneas por servidor del navegador no aplica a HTTP/2, y
  // cada stream SSE ocupa una conexión en HTTP/1.1.
  //
  // El cast es necesario porque Fastify tipa la instancia según el tipo de
  // servidor, y las rutas se escriben contra el tipo por defecto. La API de
  // compatibilidad de http2 (Http2ServerRequest/Response) cubre lo que usamos.
  const app = (options.https
    ? Fastify({
        ...base,
        http2: true,
        https: { allowHTTP1: true, cert: options.https.cert, key: options.https.key },
      })
    : Fastify(base)) as unknown as FastifyInstance;

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send(apiError(error.code, error.message, error.issues));
    }
    // Errores de Fastify con status 4xx (JSON mal formado, body demasiado grande, etc.).
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send(apiError('BAD_REQUEST', 'La solicitud no es válida.'));
    }
    request.log.error({ err: error }, 'Error no controlado');
    return reply
      .status(500)
      .send(apiError('INTERNAL_ERROR', 'Ocurrió un error interno en el servidor.'));
  });

  registerHealthRoutes(app, options.services.health);
  registerJobRoutes(app, options.services.jobs);
  registerEventRoutes(app, {
    queue: options.services.jobs,
    bus: options.services.events,
    ...(options.sseHeartbeatMs !== undefined ? { heartbeatMs: options.sseHeartbeatMs } : {}),
  });

  const webDir =
    options.webDistDir !== null && existsSync(path.join(options.webDistDir, 'index.html'))
      ? options.webDistDir
      : null;
  if (webDir !== null) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    // SPA: cualquier ruta GET que no sea de la API devuelve index.html y el
    // router de React decide qué mostrar.
    if (!isApi && webDir !== null && request.method === 'GET') {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send(apiError('NOT_FOUND', 'Recurso no encontrado.'));
  });

  return app;
}
