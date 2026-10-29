import type { HealthResponse } from '@sti-catcher/shared';
import { pino } from 'pino';
import { vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db/connection.ts';
import { createJobsRepository } from '../src/db/jobs-repository.ts';
import { migrate } from '../src/db/migrate.ts';
import { migrations } from '../src/db/migrations.ts';
import { createJobEventBus } from '../src/jobs/event-bus.ts';
import { createJobQueue } from '../src/jobs/queue.ts';
import type { JobContext, JobResult, JobRunner } from '../src/jobs/types.ts';
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

/**
 * App completa para tests: base en memoria, cola real y un runner `selftest`
 * que no termina hasta que el test lo indica (o lo cancelan).
 */
export async function makeTestApp(
  options: { webDistDir?: string | null; freeDiskBytes?: number; sseHeartbeatMs?: number } = {},
) {
  const db = openDatabase(':memory:');
  migrate(db, migrations);
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
  const queue = createJobQueue({
    repo: createJobsRepository(db),
    bus,
    runners: { selftest: runner },
    files: {
      removeByPrefix: () => Promise.resolve(0),
      moveFile: () => Promise.resolve(),
      fileSize: () => Promise.resolve(0),
    },
    paths: { tempDir: 'T:\\tmp', filesDir: 'T:\\files' },
    maxConcurrent: 1,
    minFreeDiskBytes: 1024,
    readFreeDiskBytes: () => Promise.resolve(options.freeDiskBytes ?? 1024 ** 4),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    progressIntervalMs: 0,
  });
  queue.start();

  const getHealth = vi.fn<HealthService['getHealth']>(() => Promise.resolve(sampleHealth));
  const app = await buildApp({
    logger: pino({ level: 'silent' }),
    services: { health: { getHealth }, jobs: queue, events: bus },
    webDistDir: options.webDistDir ?? null,
    https: null,
    ...(options.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: options.sseHeartbeatMs } : {}),
  });
  return { app, queue, bus, runs, getHealth };
}

/** Deja correr las microtareas pendientes de la cola. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
