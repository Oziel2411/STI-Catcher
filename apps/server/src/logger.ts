import path from 'node:path';
import { pino } from 'pino';
import type { Logger, TransportTargetOptions } from 'pino';
import type { Config } from './config/env.ts';

/**
 * Logger de la app.
 * - Siempre a archivo en LOG_DIR, con rotación diaria o a los 20 MB, y se
 *   guardan los últimos 14 archivos (pino-roll).
 * - En desarrollo, además, salida legible en consola (pino-pretty).
 * - En producción no se escribe a consola: WinSW la redirige a sus propios
 *   archivos y quedaría todo duplicado.
 */
export function createLogger(config: Pick<Config, 'nodeEnv' | 'logLevel' | 'paths'>): Logger {
  const targets: TransportTargetOptions[] = [
    {
      target: 'pino-roll',
      level: config.logLevel,
      options: {
        file: path.join(config.paths.logs, 'app'),
        extension: '.log',
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        size: '20m',
        limit: { count: 14 },
        mkdir: true,
      },
    },
  ];
  if (config.nodeEnv === 'development') {
    targets.push({
      target: 'pino-pretty',
      level: config.logLevel,
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    });
  }
  return pino({
    level: config.logLevel,
    // Por las dudas: contraseñas, tokens y cookies nunca van al log (D-100).
    redact: {
      paths: ['password', '*.password', 'token', '*.token', 'req.headers.cookie', 'headers.cookie'],
      censor: '[oculto]',
    },
    transport: { targets },
  });
}
