import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDiskSpace } from './adapters/disk.ts';
import { runCommand } from './adapters/process.ts';
import { createToolVersionReader } from './adapters/tool-version.ts';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig, resolveEnvFilePath } from './config/env.ts';
import { createLogger } from './logger.ts';
import { createHealthService } from './modules/health/health-service.ts';
import packageJson from '../package.json' with { type: 'json' };

// main.ts vive en apps/server/src (dev) o apps/server/dist (build): en ambos
// casos la raíz del repo está tres niveles arriba.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig(resolveEnvFilePath(repoRoot));

  for (const dir of Object.values(config.paths)) {
    mkdirSync(dir, { recursive: true });
  }

  const logger = createLogger(config);
  logger.info(
    { paths: config.paths, tools: config.tools, nodeEnv: config.nodeEnv },
    'Iniciando STI-Catcher',
  );

  const health = createHealthService({
    appVersion: packageJson.version,
    toolPaths: {
      'yt-dlp': config.tools.ytdlp,
      ffmpeg: config.tools.ffmpeg,
      ffprobe: config.tools.ffprobe,
      deno: config.tools.deno,
    },
    storageDir: config.paths.storage,
    minFreeDiskBytes: config.limits.minFreeDiskBytes,
    readToolVersion: createToolVersionReader(runCommand),
    readDiskSpace,
    // Se conecta a la cola de jobs en la Fase 2.
    getJobCounts: () => ({ running: 0, queued: 0, maxConcurrent: config.limits.maxConcurrentJobs }),
  });

  const app = await buildApp({
    logger,
    services: { health },
    webDistDir: config.nodeEnv === 'production' ? path.join(repoRoot, 'apps', 'web', 'dist') : null,
    https: config.server.https
      ? {
          cert: readFileSync(config.server.https.certPath),
          key: readFileSync(config.server.https.keyPath),
        }
      : null,
  });

  // WinSW detiene el servicio enviando Ctrl+C (SIGINT).
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Deteniendo el servidor');
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Error al detener el servidor');
        process.exit(1);
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: config.server.host, port: config.server.port });
  const protocol = config.server.https ? 'https' : 'http';
  logger.info(`Escuchando en ${protocol}://${config.server.host}:${config.server.port}`);
}

main().catch((error: unknown) => {
  // El logger puede no existir todavía (p. ej. .env inválido): va a stderr.
  if (error instanceof ConfigError) {
    console.error(`\n[STI-Catcher] ${error.message}\n`);
  } else {
    console.error('[STI-Catcher] Error fatal al iniciar:', error);
  }
  process.exit(1);
});
