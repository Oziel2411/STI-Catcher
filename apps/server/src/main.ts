import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDiskSpace } from './adapters/disk.ts';
import { createFfmpegRunner } from './adapters/ffmpeg.ts';
import { createFfprobe } from './adapters/ffprobe.ts';
import { fileOps } from './adapters/files.ts';
import { acquireInstanceLock, InstanceLockError } from './adapters/instance-lock.ts';
import { killProcessTree, runCommand, runStreaming } from './adapters/process.ts';
import { createProcessLister } from './adapters/process-list.ts';
import { createToolVersionReader } from './adapters/tool-version.ts';
import { createUrlGuard } from './adapters/url-guard.ts';
import { createYtdlp } from './adapters/ytdlp.ts';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig, resolveEnvFilePath } from './config/env.ts';
import { openDatabase } from './db/connection.ts';
import { createJobsRepository } from './db/jobs-repository.ts';
import { migrate } from './db/migrate.ts';
import { migrations } from './db/migrations.ts';
import { createJobEventBus } from './jobs/event-bus.ts';
import { createJobQueue } from './jobs/queue.ts';
import { recoverOnStartup } from './jobs/recovery.ts';
import { createLogger } from './logger.ts';
import { createRecordingsRepository } from './db/recordings-repository.ts';
import { createSessionsRepository } from './db/sessions-repository.ts';
import { createUsersRepository } from './db/users-repository.ts';
import { createAuthService } from './modules/auth/auth-service.ts';
import { createLoginLimiter } from './modules/auth/login-limiter.ts';
import { createUsersService } from './modules/auth/users-service.ts';
import { createConversionRunner } from './modules/conversion/conversion-runner.ts';
import { createConversionService } from './modules/conversion/conversion-service.ts';
import { createUploadService } from './modules/conversion/upload-service.ts';
import { createDownloadRunner } from './modules/download/download-runner.ts';
import { createDownloadService } from './modules/download/download-service.ts';
import { createFollowUps } from './modules/download/follow-up.ts';
import { createHostResolver } from './adapters/host-resolver.ts';
import { createSmtpMailer } from './adapters/mailer.ts';
import { createMailService } from './modules/notifications/mail-service.ts';
import { createRecordingNotice } from './modules/notifications/recording-notice.ts';
import { createJobFiles } from './modules/files/job-files.ts';
import { createHistoryService } from './modules/history/history-service.ts';
import { createHealthService } from './modules/health/health-service.ts';
import { createRecordingRunner } from './modules/recording/recording-runner.ts';
import { createRecordingService } from './modules/recording/recording-service.ts';
import { createRetentionService } from './modules/retention/retention-service.ts';
import { createSelftestRunner } from './modules/selftest/selftest-runner.ts';
import packageJson from '../package.json' with { type: 'json' };

// main.ts vive en apps/server/src (dev) o apps/server/dist (build): en ambos
// casos la raíz del repo está tres niveles arriba.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig(resolveEnvFilePath(repoRoot));
  const storage = {
    tempDir: path.join(config.paths.storage, 'tmp'),
    filesDir: path.join(config.paths.storage, 'files'),
    // Crudos de grabaciones en curso. No van en tmp: tmp se vacía al arrancar, y
    // una grabación tiene que sobrevivir a un reinicio (se procesa lo que llegó).
    recordingsDir: path.join(config.paths.storage, 'recordings'),
  };
  // Cachés de yt-dlp y Deno dentro de DATA_DIR: la cuenta del servicio no tiene perfil normal (D-012).
  const caches = {
    ytdlp: path.join(config.paths.data, 'cache', 'yt-dlp'),
    deno: path.join(config.paths.data, 'cache', 'deno'),
  };
  for (const dir of [
    ...Object.values(config.paths),
    ...Object.values(storage),
    ...Object.values(caches),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const logger = createLogger(config);
  logger.info(
    { paths: config.paths, tools: config.tools, nodeEnv: config.nodeEnv },
    'Iniciando STI-Catcher',
  );

  // Una sola instancia por DATA_DIR, antes de tocar procesos o la base (D-033).
  const listProcesses = createProcessLister(runCommand);
  const lock = await acquireInstanceLock({
    lockPath: path.join(config.paths.data, 'sti-catcher.pid'),
    selfPid: process.pid,
    isOtherInstance: async (pid) => {
      try {
        const proc = (await listProcesses()).find((p) => p.pid === pid);
        return (
          proc !== undefined && path.basename(proc.executablePath).toLowerCase() === 'node.exe'
        );
      } catch {
        // Sin lista de procesos, alcanza con saber si el PID existe (conservador).
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }
    },
  });

  const db = openDatabase(path.join(config.paths.data, 'sti-catcher.db'));
  const applied = migrate(db, migrations);
  if (applied.length > 0) {
    logger.info(
      { migrations: applied.map((m) => `${String(m.version)}-${m.name}`) },
      'Migraciones aplicadas',
    );
  }
  const repo = createJobsRepository(db);
  const users = createUsersRepository(db);
  // Login obligatorio (D-100). Sin cuentas nadie puede entrar: se avisa cómo crear la primera.
  const sessions = createSessionsRepository(db);
  const loginLimiter = createLoginLimiter();
  const auth = createAuthService({ users, sessions, limiter: loginLimiter, logger });
  const usersService = createUsersService({
    users,
    sessions,
    auth,
    limiter: loginLimiter,
    logger,
  });
  if (users.countAdmins() === 0) {
    logger.warn(
      'No hay ninguna cuenta de administrador: creala en el servidor con «npm run user:create-admin».',
    );
  }

  await recoverOnStartup({
    repo,
    listProcesses,
    killProcessTree,
    files: fileOps,
    binDir: config.paths.bin,
    tempDir: storage.tempDir,
    selfPid: process.pid,
    now: () => new Date(),
    logger,
  });

  const bus = createJobEventBus((error) => {
    logger.warn({ err: error }, 'Error en un suscriptor de eventos');
  });
  const runFfmpeg = createFfmpegRunner(runStreaming, config.tools.ffmpeg);
  const ffprobe = createFfprobe(runCommand, config.tools.ffprobe);
  const checkUrl = createUrlGuard({ enabled: config.download.blockPrivateUrls });
  const ytdlp = createYtdlp({
    runCommand,
    runStreaming,
    ytdlpPath: config.tools.ytdlp,
    ffmpegPath: config.tools.ffmpeg,
    base: {
      extractors: config.download.ytdlpExtractors,
      denoPath: config.tools.deno,
      cacheDir: caches.ytdlp,
    },
    denoDir: caches.deno,
  });
  const queue = createJobQueue({
    repo,
    bus,
    runners: {
      selftest: createSelftestRunner({ runFfmpeg, files: fileOps }),
      download: createDownloadRunner({ ytdlp, runFfmpeg, ffprobe, files: fileOps, checkUrl }),
      conversion: createConversionRunner({
        getJob: (id) => repo.get(id),
        storageDir: config.paths.storage,
        filesDir: storage.filesDir,
        ffprobe,
        runFfmpeg,
      }),
      recording: createRecordingRunner({
        recordingsDir: storage.recordingsDir,
        ffprobe,
        runFfmpeg,
        removeFile: fileOps.removeFile,
      }),
    },
    files: fileOps,
    paths: storage,
    maxConcurrent: config.limits.maxConcurrentJobs,
    minFreeDiskBytes: config.limits.minFreeDiskBytes,
    readFreeDiskBytes: async () => (await readDiskSpace(config.paths.storage)).freeBytes,
    // La conversión encadenada necesita el servicio de conversión, que necesita la cola.
    onDone: async (record) => {
      notifyRecording(record);
      await followUps(record);
    },
    resolveHost: createHostResolver(),
    logger,
  });

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
    getJobCounts: () => queue.counts(),
  });

  const download = createDownloadService({
    ytdlp,
    checkUrl,
    enqueue: (input) => queue.enqueue(input),
    logger,
  });
  const jobFiles = createJobFiles({
    getJob: (id) => repo.get(id),
    storageDir: config.paths.storage,
    filesDir: storage.filesDir,
    onMissing: (id) => queue.expire(id),
  });
  const history = createHistoryService({
    repo,
    queue,
    storageDir: config.paths.storage,
    filesDir: storage.filesDir,
    removeFile: fileOps.removeFile,
    logger,
    userNames: (ids) => users.namesByIds(ids),
  });
  const gifLimits = {
    ...config.gif,
    defaultFps: Math.min(10, config.gif.maxFps),
    defaultWidth: Math.min(480, config.gif.maxWidth),
  };
  const conversion = createConversionService({
    getJob: (id) => repo.get(id),
    storageDir: config.paths.storage,
    filesDir: storage.filesDir,
    ffprobe,
    queue,
    gifLimits,
  });
  const followUps = createFollowUps({ conversion, queue, repo, logger });
  // Aviso por mail al terminar una grabación (D-099). Sin SMTP o sin MAIL_TO, nada.
  const sendMail = config.mail ? createSmtpMailer(config.mail) : null;
  const mail = createMailService({
    send: sendMail,
    from: config.mail?.from ?? null,
    to: config.mail?.to ?? [],
  });
  const notifyRecording = sendMail
    ? createRecordingNotice({ send: sendMail, to: config.mail?.to ?? [], logger })
    : () => undefined;
  if (config.mail) {
    logger.info(
      { host: config.mail.host, port: config.mail.port, recipients: config.mail.to.length },
      config.mail.to.length > 0
        ? 'Aviso por mail de grabaciones activo'
        : 'Mail configurado sin destinatarios (MAIL_TO): no se mandan avisos',
    );
  }
  const upload = createUploadService({
    tempDir: storage.tempDir,
    filesDir: storage.filesDir,
    maxUploadBytes: config.limits.maxUploadBytes,
    minFreeDiskBytes: config.limits.minFreeDiskBytes,
    readFreeDiskBytes: async () => (await readDiskSpace(config.paths.storage)).freeBytes,
    ffprobe,
    files: fileOps,
    queue,
  });
  const conversionOptions = { gif: gifLimits, maxUploadBytes: config.limits.maxUploadBytes };
  const recordings = createRecordingService({
    repo: createRecordingsRepository(db),
    recordingsDir: storage.recordingsDir,
    minFreeDiskBytes: config.limits.minFreeDiskBytes,
    readFreeDiskBytes: async () => (await readDiskSpace(config.paths.storage)).freeBytes,
    queue,
    idleMinutes: config.recording.idleMinutes,
    logger,
  });

  const retention = createRetentionService({
    retentionDays: config.limits.retentionDays,
    repo,
    expire: (id) => queue.expire(id),
    storageDir: config.paths.storage,
    filesDir: storage.filesDir,
    recordingsDir: storage.recordingsDir,
    logger,
  });

  const app = await buildApp({
    logger,
    services: {
      health,
      jobs: queue,
      events: bus,
      download,
      jobFiles,
      history,
      conversion,
      upload,
      conversionOptions,
      recordings,
      mail,
      auth,
      users: usersService,
      getUser: (id) => users.get(id),
    },
    // En desarrollo la web la sirve Vite (otro puerto) y los POST llegan con su Origin.
    ...(config.nodeEnv === 'development'
      ? { extraOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'] }
      : {}),
    filesDir: storage.filesDir,
    webDistDir: config.nodeEnv === 'production' ? path.join(repoRoot, 'apps', 'web', 'dist') : null,
    https: config.server.https
      ? {
          cert: readFileSync(config.server.https.certPath),
          key: readFileSync(config.server.https.keyPath),
        }
      : null,
  });

  // WinSW detiene el servicio enviando Ctrl+C (SIGINT). Orden: cortar jobs
  // (matan sus procesos y quedan "interrumpido"), cerrar HTTP y SSE, cerrar la base.
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Deteniendo el servidor');
    recordings.stop();
    retention.stop();
    queue
      .stop()
      .then(() => app.close())
      .then(() => {
        db.close();
        lock.release();
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Error al detener el servidor');
        lock.release();
        process.exit(1);
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: config.server.host, port: config.server.port });
  queue.start();
  // Cierra grabaciones abandonadas, incluidas las que quedaron abiertas antes de un reinicio.
  recordings.start();
  // Retención: una pasada ahora y después cada hora (RETENTION_DAYS=0 la desactiva).
  retention.start();
  const protocol = config.server.https ? 'https' : 'http';
  logger.info(`Escuchando en ${protocol}://${config.server.host}:${String(config.server.port)}`);
}

main().catch((error: unknown) => {
  // El logger puede no existir todavía (p. ej. .env inválido): va a stderr.
  if (error instanceof ConfigError || error instanceof InstanceLockError) {
    console.error(`\n[STI-Catcher] ${error.message}\n`);
  } else {
    console.error('[STI-Catcher] Error fatal al iniciar:', error);
  }
  process.exit(1);
});
