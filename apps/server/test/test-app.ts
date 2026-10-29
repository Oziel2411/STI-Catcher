import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HealthResponse, ProbeResponse } from '@sti-catcher/shared';
import { pino } from 'pino';
import { vi } from 'vitest';
import type { UrlGuard } from '../src/adapters/url-guard.ts';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db/connection.ts';
import { createJobsRepository } from '../src/db/jobs-repository.ts';
import { migrate } from '../src/db/migrate.ts';
import { migrations } from '../src/db/migrations.ts';
import { createJobEventBus } from '../src/jobs/event-bus.ts';
import { createJobQueue } from '../src/jobs/queue.ts';
import type { JobContext, JobResult, JobRunner } from '../src/jobs/types.ts';
import { createDownloadService } from '../src/modules/download/download-service.ts';
import { createJobFiles } from '../src/modules/files/job-files.ts';
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
    runners: { selftest: runner, download: runner },
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
  });
  queue.start();

  const probe = vi.fn(options.probe ?? (() => Promise.reject(new Error('probe no configurado'))));
  const download = createDownloadService({
    ytdlp: { probe },
    checkUrl: options.checkUrl ?? (() => Promise.resolve()),
    enqueue: (input) => queue.enqueue(input),
    logger: { warn: vi.fn() },
  });
  const jobFiles = createJobFiles({ getJob: (id) => repo.get(id), storageDir, filesDir });

  const getHealth = vi.fn<HealthService['getHealth']>(() => Promise.resolve(sampleHealth));
  const app = await buildApp({
    logger: pino({ level: 'silent' }),
    services: { health: { getHealth }, jobs: queue, events: bus, download, jobFiles },
    filesDir,
    webDistDir: options.webDistDir ?? null,
    https: null,
    ...(options.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: options.sseHeartbeatMs } : {}),
  });
  return { app, queue, repo, bus, runs, getHealth, probe, storageDir, filesDir };
}

/** Deja correr las microtareas pendientes de la cola. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
