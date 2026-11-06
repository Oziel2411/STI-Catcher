import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HealthResponse, ProbeResponse } from '@sti-catcher/shared';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { pino } from 'pino';
import { vi } from 'vitest';
import type { Ffprobe, MediaInfo } from '../src/adapters/ffprobe.ts';
import { fileOps } from '../src/adapters/files.ts';
import type { UrlGuard } from '../src/adapters/url-guard.ts';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db/connection.ts';
import { createJobsRepository } from '../src/db/jobs-repository.ts';
import { createRecordingsRepository } from '../src/db/recordings-repository.ts';
import { createSessionsRepository } from '../src/db/sessions-repository.ts';
import { createUsersRepository } from '../src/db/users-repository.ts';
import { createAuthService } from '../src/modules/auth/auth-service.ts';
import { createLoginLimiter } from '../src/modules/auth/login-limiter.ts';
import { migrate } from '../src/db/migrate.ts';
import { migrations } from '../src/db/migrations.ts';
import { createJobEventBus } from '../src/jobs/event-bus.ts';
import { createJobQueue } from '../src/jobs/queue.ts';
import type { JobContext, JobResult, JobRunner } from '../src/jobs/types.ts';
import { createConversionService } from '../src/modules/conversion/conversion-service.ts';
import { createUploadService } from '../src/modules/conversion/upload-service.ts';
import { createRecordingService } from '../src/modules/recording/recording-service.ts';
import { createDownloadService } from '../src/modules/download/download-service.ts';
import { createFollowUps } from '../src/modules/download/follow-up.ts';
import type { MailMessage, SendMail } from '../src/adapters/mailer.ts';
import { createMailService } from '../src/modules/notifications/mail-service.ts';
import { createRecordingNotice } from '../src/modules/notifications/recording-notice.ts';
import { createJobFiles } from '../src/modules/files/job-files.ts';
import { createHistoryService } from '../src/modules/history/history-service.ts';
import type { HealthService } from '../src/modules/health/health-service.ts';

export const sampleHealth: HealthResponse = {
  status: 'ok',
  app: { version: '0.1.0', nodeVersion: '24.19.0', uptimeSeconds: 1 },
  tools: [{ name: 'yt-dlp', version: '2026.10.20', error: null }],
  disk: { freeBytes: 10, totalBytes: 20, minFreeBytes: 1, isLow: false },
  jobs: { running: 0, queued: 0, maxConcurrent: 2 },
  toolsCheckedAt: '2026-10-29T12:00:00.000Z',
};

export type PendingRun = {
  context: JobContext;
  resolve: (result: JobResult) => void;
};

export type TestAppOptions = {
  webDistDir?: string | null;
  freeDiskBytes?: number;
  sseHeartbeatMs?: number;
  probe?: (url: string) => Promise<ProbeResponse>;
  checkUrl?: UrlGuard;
  /** ffprobe falso para subidas y conversiones (por defecto: video H.264 + AAC de 12 s). */
  ffprobe?: Ffprobe;
  maxUploadBytes?: number;
  /** IP → nombre de la PC (por defecto no se resuelve). */
  resolveHost?: (ip: string) => Promise<string | null>;
  /** Destinatarios del aviso por mail. Los mails no salen: quedan en `sentMails`. */
  mailTo?: string[];
  /** Simula un servidor de correo que falla. */
  sendMail?: SendMail;
  /** Reloj de las sesiones (para probar el corte por inactividad). */
  authNow?: () => Date;
};

/** Contraseña de las cuentas que crea `loginAs`. */
export const TEST_PASSWORD = 'contraseña-de-prueba';

/**
 * Hash falso para los tests de rutas: scrypt tarda ~100 ms por llamada. El
 * real se prueba en password.test.ts.
 */
const fakeHash = (password: string) => Promise.resolve(`fake$${password}`);
const fakeVerify = (password: string, stored: string) =>
  Promise.resolve(stored === `fake$${password}`);

export const sampleVideoMedia: MediaInfo = {
  durationSeconds: 12,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  sizeBytes: 1000,
  video: { codec: 'hevc', width: 1920, height: 1080, pixFmt: 'yuv420p' },
  audio: { codec: 'aac', channels: 2 },
};

export const testGifLimits = {
  maxSeconds: 30,
  maxFps: 15,
  maxWidth: 800,
  defaultFps: 10,
  defaultWidth: 480,
};

/**
 * App completa para tests: base en memoria, cola real y runners (`selftest`,
 * `download`) que no terminan hasta que el test lo indica (o los cancelan).
 * `storageDir` es una carpeta temporal real: los tests de archivos escriben ahí.
 */
export async function makeTestApp(options: TestAppOptions = {}) {
  const db = openDatabase(':memory:');
  migrate(db, migrations);
  const repo = createJobsRepository(db);
  const users = createUsersRepository(db);
  const sessions = createSessionsRepository(db);
  const authLogger = { info: vi.fn(), warn: vi.fn() };
  const auth = createAuthService({
    users,
    sessions,
    limiter: createLoginLimiter(),
    logger: authLogger,
    hash: fakeHash,
    verify: fakeVerify,
    ...(options.authNow ? { now: options.authNow } : {}),
  });
  const bus = createJobEventBus();
  const runs: PendingRun[] = [];
  const runner: JobRunner = {
    run: (context) =>
      new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          reject(context.signal.reason as Error);
        });
        runs.push({ context, resolve });
      }),
  };
  const storageDir = mkdtempSync(path.join(tmpdir(), 'sti-storage-'));
  const filesDir = path.join(storageDir, 'files');

  const queue = createJobQueue({
    repo,
    bus,
    runners: { selftest: runner, download: runner, conversion: runner, recording: runner },
    files: {
      removeByPrefix: () => Promise.resolve(0),
      moveFile: () => Promise.resolve(),
      fileSize: () => Promise.resolve(0),
    },
    paths: { tempDir: path.join(storageDir, 'tmp'), filesDir },
    maxConcurrent: 1,
    minFreeDiskBytes: 1024,
    readFreeDiskBytes: () => Promise.resolve(options.freeDiskBytes ?? 1024 ** 4),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    progressIntervalMs: 0,
    onDone: async (record) => {
      notifyRecording(record);
      await followUps(record);
    },
    ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
  });
  queue.start();

  const probe = vi.fn(options.probe ?? (() => Promise.reject(new Error('probe no configurado'))));
  const download = createDownloadService({
    ytdlp: { probe },
    checkUrl: options.checkUrl ?? (() => Promise.resolve()),
    enqueue: (input) => queue.enqueue(input),
    logger: { warn: vi.fn() },
  });
  const jobFiles = createJobFiles({
    getJob: (id) => repo.get(id),
    storageDir,
    filesDir,
    onMissing: (id) => queue.expire(id),
  });
  const historyLogger = { info: vi.fn() };
  const history = createHistoryService({
    repo,
    queue,
    storageDir,
    filesDir,
    removeFile: (file) => rm(file, { force: true }),
    logger: historyLogger,
    userNames: (ids) => users.namesByIds(ids),
  });

  const ffprobe = vi.fn<Ffprobe>(options.ffprobe ?? (() => Promise.resolve(sampleVideoMedia)));
  const conversion = createConversionService({
    getJob: (id) => repo.get(id),
    storageDir,
    filesDir,
    ffprobe,
    queue,
    gifLimits: testGifLimits,
  });
  const followUps = createFollowUps({ conversion, queue, repo, logger: { warn: vi.fn() } });
  const sentMails: MailMessage[] = [];
  const sendMail: SendMail =
    options.sendMail ??
    ((message) => {
      sentMails.push(message);
      return Promise.resolve();
    });
  const mailTo = options.mailTo ?? [];
  const notifyRecording = createRecordingNotice({
    send: sendMail,
    to: mailTo,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  const mail = createMailService({
    send: options.mailTo ? sendMail : null,
    from: options.mailTo ? 'avisos@capitanes.ar' : null,
    to: mailTo,
  });
  mkdirSync(path.join(storageDir, 'tmp'), { recursive: true });
  mkdirSync(filesDir, { recursive: true });
  const upload = createUploadService({
    tempDir: path.join(storageDir, 'tmp'),
    filesDir,
    maxUploadBytes: options.maxUploadBytes ?? 1024 ** 3,
    minFreeDiskBytes: 1024,
    readFreeDiskBytes: () => Promise.resolve(options.freeDiskBytes ?? 1024 ** 4),
    ffprobe,
    files: fileOps,
    queue,
  });
  const conversionOptions = {
    gif: testGifLimits,
    maxUploadBytes: options.maxUploadBytes ?? 1024 ** 3,
  };
  const recordingsDir = path.join(storageDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  // Reloj controlable para probar el cierre por inactividad.
  const clock = { now: new Date('2026-10-29T12:00:00.000Z') };
  const recordingsRepo = createRecordingsRepository(db);
  const recordings = createRecordingService({
    repo: recordingsRepo,
    recordingsDir,
    minFreeDiskBytes: 1024,
    readFreeDiskBytes: () => Promise.resolve(options.freeDiskBytes ?? 1024 ** 4),
    queue,
    idleMinutes: 2,
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => clock.now,
  });

  const getHealth = vi.fn<HealthService['getHealth']>(() => Promise.resolve(sampleHealth));
  const app = await buildApp({
    logger: pino({ level: 'silent' }),
    services: {
      health: { getHealth },
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
    },
    filesDir,
    webDistDir: options.webDistDir ?? null,
    https: null,
    ...(options.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: options.sseHeartbeatMs } : {}),
  });
  /**
   * Ingresa con una cuenta (la crea si no existe) y devuelve los headers con
   * su cookie de sesión. El nombre es la parte del mail antes de la @.
   */
  const loginAs = async (email: string, role: 'admin' | 'user' = 'user') => {
    if (!users.findByEmail(email)) {
      const name = email.split('@')[0] ?? email;
      await auth.createUser({ email, name, role, password: TEST_PASSWORD });
    }
    const { token, user } = await auth.login({ email, password: TEST_PASSWORD }, '127.0.0.1');
    return { headers: { cookie: `sti_session=${token}` }, user };
  };

  // Por defecto cada pedido va con la sesión de «ana»: los tests que no son
  // del login no tienen que ocuparse. Un `cookie` explícito la reemplaza
  // (`cookie: ''` = sin sesión).
  const ana = await loginAs('ana@capitanes.ar');
  const rawInject = app.inject.bind(app) as unknown as (
    opts: InjectOptions,
  ) => Promise<LightMyRequestResponse>;
  app.inject = ((opts: InjectOptions | string) =>
    rawInject(
      typeof opts === 'string'
        ? { url: opts, headers: ana.headers }
        : { ...opts, headers: { ...ana.headers, ...opts.headers } },
    )) as typeof app.inject;

  return {
    app,
    auth,
    authLogger,
    users,
    sessions,
    loginAs,
    /** Cuenta y headers de la sesión por defecto. */
    ana,
    queue,
    repo,
    bus,
    runs,
    getHealth,
    probe,
    ffprobe,
    storageDir,
    filesDir,
    historyLogger,
    recordings,
    recordingsRepo,
    recordingsDir,
    clock,
    sentMails,
  };
}

/** Deja correr las microtareas pendientes de la cola. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
