import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { ApiError, ConversionOptionsResponse } from '@sti-catcher/shared';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { registerClientId } from './http/client-id.ts';
import { HttpError } from './http/validation.ts';
import type { JobEventBus } from './jobs/event-bus.ts';
import type { JobQueue } from './jobs/queue.ts';
import type { ConversionService } from './modules/conversion/conversion-service.ts';
import type { UploadService } from './modules/conversion/upload-service.ts';
import type { DownloadService } from './modules/download/download-service.ts';
import type { HistoryService } from './modules/history/history-service.ts';
import type { JobFiles } from './modules/files/job-files.ts';
import type { HealthService } from './modules/health/health-service.ts';
import { registerConversionRoutes } from './routes/conversion.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerHistoryRoutes } from './routes/history.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerJobRoutes } from './routes/jobs.ts';
import { registerMediaRoutes } from './routes/media.ts';

export type AppServices = {
  health: HealthService;
  jobs: JobQueue;
  events: JobEventBus;
  download: DownloadService;
  jobFiles: JobFiles;
  history: HistoryService;
  conversion: ConversionService;
  upload: UploadService;
  conversionOptions: ConversionOptionsResponse;
};

export type BuildAppOptions = {
  logger: Logger;
  services: AppServices;
  /** STORAGE_DIR/files: de acá se sirven los archivos de los jobs. */
  filesDir: string;
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

  // @fastify/static se registra siempre, sin servir rutas propias: aporta
  // reply.download / reply.sendFile (Range, Content-Disposition RFC 5987).
  await app.register(fastifyStatic, { root: options.filesDir, serve: false });

  // Cookie anónima por navegador para "Mis trabajos" (D-041). Secure solo con HTTPS.
  registerClientId(app, { secure: options.https !== null });

  registerHealthRoutes(app, options.services.health);
  registerJobRoutes(app, options.services.jobs);
  registerMediaRoutes(app, options.services.download);
  registerFileRoutes(app, options.services.jobFiles);
  registerHistoryRoutes(app, options.services.history);
  registerConversionRoutes(app, {
    conversion: options.services.conversion,
    upload: options.services.upload,
    options: options.services.conversionOptions,
  });
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
    // Segunda instancia: sirve la web. decorateReply false porque la primera ya decoró reply.
    await app.register(fastifyStatic, { root: webDir, wildcard: false, decorateReply: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    // SPA: cualquier ruta GET que no sea de la API devuelve index.html y el
    // router de React decide qué mostrar.
    if (!isApi && webDir !== null && request.method === 'GET') {
      return reply.type('text/html').sendFile('index.html', webDir);
    }
    return reply.status(404).send(apiError('NOT_FOUND', 'Recurso no encontrado.'));
  });

  return app;
}
