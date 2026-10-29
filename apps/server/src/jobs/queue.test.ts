import type { Job, JobEvent } from '@sti-catcher/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/connection.ts';
import { createJobsRepository } from '../db/jobs-repository.ts';
import { migrate } from '../db/migrate.ts';
import { migrations } from '../db/migrations.ts';
import { INTERRUPTED_MESSAGE, JobError, JobRejectedError, UNEXPECTED_MESSAGE } from './errors.ts';
import { createJobEventBus } from './event-bus.ts';
import { createJobQueue } from './queue.ts';
import type { JobQueueDeps } from './queue.ts';
import type { JobContext, JobResult, JobRunner } from './types.ts';

const GB = 1024 ** 3;

/** Runner que no termina hasta que el test lo indica (o hasta que lo abortan). */
function controllableRunner() {
  const calls: {
    context: JobContext;
    resolve: (result: JobResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const runner: JobRunner = {
    run: (context) =>
      new Promise<JobResult>((resolve, reject) => {
        // Igual que runStreaming: un abort rechaza con signal.reason.
        context.signal.addEventListener('abort', () => {
          reject(context.signal.reason as Error);
        });
        calls.push({ context, resolve, reject });
      }),
  };
  return { runner, calls };
}

function setup(overrides: Partial<JobQueueDeps> = {}) {
  const db = openDatabase(':memory:');
  migrate(db, migrations);
  const repo = createJobsRepository(db);
  const bus = createJobEventBus();
  const events: JobEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const { runner, calls } = controllableRunner();
  const files = {
    removeByPrefix: vi.fn(() => Promise.resolve(0)),
    moveFile: vi.fn(() => Promise.resolve()),
    fileSize: vi.fn(() => Promise.resolve(4096)),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let counter = 0;
  const queue = createJobQueue({
    repo,
    bus,
    runners: { selftest: runner },
    files,
    paths: { tempDir: 'S:\\storage\\tmp', filesDir: 'S:\\storage\\files' },
    maxConcurrent: 2,
    minFreeDiskBytes: 5 * GB,
    readFreeDiskBytes: () => Promise.resolve(100 * GB),
    logger,
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    progressIntervalMs: 0,
    ...overrides,
  });
  return { queue, repo, events, calls, files, logger };
}

/** Deja correr las promesas pendientes (la cola trabaja en microtareas). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Espera a que el job llegue a un estado final según los eventos publicados. */
async function waitForFinal(events: JobEvent[], id: string): Promise<Job> {
  for (let i = 0; i < 50; i++) {
    const final = events.find(
      (e): e is Extract<JobEvent, { type: 'job.updated' }> =>
        e.type === 'job.updated' &&
        e.job.id === id &&
        !['queued', 'running'].includes(e.job.status),
    );
    if (final) return final.job;
    await flush();
  }
  throw new Error(`El job ${id} no terminó`);
}

const selftest = { type: 'selftest' as const, params: { durationSeconds: 10 } };

describe('createJobQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('respeta la concurrencia máxima y el orden de llegada', async () => {
    const { queue, calls } = setup();
    queue.start();
    const a = await queue.enqueue(selftest);
    const b = await queue.enqueue(selftest);
    const c = await queue.enqueue(selftest);
    await flush();

    expect(calls.map((call) => call.context.job.id)).toEqual([a.id, b.id]);
    expect(queue.counts()).toEqual({ running: 2, queued: 1, maxConcurrent: 2 });
    expect(queue.get(c.id)?.status).toBe('queued');

    calls[0]?.resolve({ output: null });
    await flush();
    expect(calls.map((call) => call.context.job.id)).toEqual([a.id, b.id, c.id]);
  });

  it('no arranca nada hasta start() (los queued de antes de un reinicio esperan la recuperación)', async () => {
    const { queue, calls } = setup();
    await queue.enqueue(selftest);
    await flush();
    expect(calls).toHaveLength(0);
    queue.start();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('un job exitoso con archivo lo mueve a files/<id><ext> y guarda el tamaño real', async () => {
    const { queue, calls, files, events } = setup();
    queue.start();
    const job = await queue.enqueue(selftest);
    await flush();
    calls[0]?.resolve({
      output: { tempPath: `S:\\storage\\tmp\\${job.id}.mp4`, extension: '.mp4' },
      metadata: { title: 'Mi video', durationSeconds: 12.5 },
    });

    const final = await waitForFinal(events, job.id);
    expect(files.moveFile).toHaveBeenCalledWith(
      `S:\\storage\\tmp\\${job.id}.mp4`,
      `S:\\storage\\files\\${job.id}.mp4`,
    );
    expect(final).toMatchObject({
      status: 'done',
      title: 'Mi video',
      sizeBytes: 4096,
      durationSeconds: 12.5,
      progress: null,
    });
    expect(final.finishedAt).not.toBeNull();
  });

  it('cancelar un job en cola lo marca cancelado sin ejecutarlo', async () => {
    const { queue, calls } = setup({ maxConcurrent: 1 });
    queue.start();
    await queue.enqueue(selftest);
    const queued = await queue.enqueue(selftest);
    await flush();

    const result = queue.cancel(queued.id);
    expect(result.outcome).toBe('cancelled');
    calls[0]?.resolve({ output: null });
    await flush();
    expect(calls).toHaveLength(1);
    expect(queue.get(queued.id)?.status).toBe('cancelled');
  });

  it('cancelar un job en curso aborta el runner, borra temporales y después publica cancelled', async () => {
    const { queue, calls, files, events } = setup();
    queue.start();
    const job = await queue.enqueue(selftest);
    await flush();

    // Registra cuántos eventos había publicados en el momento de limpiar.
    let eventsAtCleanup = -1;
    files.removeByPrefix.mockImplementation(() => {
      eventsAtCleanup = events.length;
      return Promise.resolve(2);
    });

    expect(queue.cancel(job.id).outcome).toBe('cancelling');
    expect(calls[0]?.context.signal.aborted).toBe(true);

    const final = await waitForFinal(events, job.id);
    expect(final.status).toBe('cancelled');
    expect(files.removeByPrefix).toHaveBeenCalledWith('S:\\storage\\tmp', job.id);
    // Cuando se limpió, el evento "cancelled" todavía no se había publicado.
    const finalIndex = events.findIndex(
      (e) => e.type === 'job.updated' && e.job.id === job.id && e.job.status === 'cancelled',
    );
    expect(eventsAtCleanup).toBeGreaterThanOrEqual(0);
    expect(finalIndex).toBeGreaterThanOrEqual(eventsAtCleanup);
    expect(queue.cancel(job.id).outcome).toBe('not_active');
  });

  it('cancelar un id inexistente devuelve not_found', () => {
    const { queue } = setup();
    expect(queue.cancel('00000000-0000-4000-8000-999999999999')).toEqual({ outcome: 'not_found' });
  });

  it('stop() corta los jobs en curso como "interrumpido" y deja los queued para el próximo arranque', async () => {
    const { queue, calls } = setup({ maxConcurrent: 1 });
    queue.start();
    const running = await queue.enqueue(selftest);
    const waiting = await queue.enqueue(selftest);
    await flush();

    await queue.stop();
    expect(calls[0]?.context.signal.aborted).toBe(true);
    expect(queue.get(running.id)).toMatchObject({ status: 'failed', error: INTERRUPTED_MESSAGE });
    expect(queue.get(waiting.id)?.status).toBe('queued');
    expect(calls).toHaveLength(1);
  });

  it('rechaza crear jobs sin espacio en disco, con un mensaje claro', async () => {
    const { queue } = setup({ readFreeDiskBytes: () => Promise.resolve(2 * GB) });
    const error = await queue.enqueue(selftest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobRejectedError);
    expect((error as JobRejectedError).code).toBe('INSUFFICIENT_DISK');
    expect((error as Error).message).toContain('2,0 GB');
    expect((error as Error).message).toContain('5,0 GB');
  });

  it('si el disco se llena mientras el job espera, falla al intentar arrancarlo', async () => {
    let free = 100 * GB;
    const { queue, calls, events } = setup({
      maxConcurrent: 1,
      readFreeDiskBytes: () => Promise.resolve(free),
    });
    queue.start();
    await queue.enqueue(selftest);
    const second = await queue.enqueue(selftest);
    await flush();
    free = 1 * GB;
    calls[0]?.resolve({ output: null });

    const final = await waitForFinal(events, second.id);
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/Espacio insuficiente/);
    expect(calls).toHaveLength(1);
  });

  it('un JobError muestra su mensaje; cualquier otro error, uno genérico (y va al log)', async () => {
    const { queue, calls, events, logger } = setup();
    queue.start();
    const a = await queue.enqueue(selftest);
    const b = await queue.enqueue(selftest);
    await flush();
    calls[0]?.reject(new JobError('El video es privado.'));
    calls[1]?.reject(new Error('C:\\ruta\\interna explotó'));

    expect((await waitForFinal(events, a.id)).error).toBe('El video es privado.');
    expect((await waitForFinal(events, b.id)).error).toBe(UNEXPECTED_MESSAGE);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rechaza extensiones raras devueltas por un runner', async () => {
    const { queue, calls, events } = setup();
    queue.start();
    const job = await queue.enqueue(selftest);
    await flush();
    calls[0]?.resolve({ output: { tempPath: 'x', extension: '.mp4\\..\\..\\evil' } });
    expect((await waitForFinal(events, job.id)).error).toBe(UNEXPECTED_MESSAGE);
  });

  it('publica el progreso y lo incluye en el job mientras corre', async () => {
    const { queue, calls, events } = setup();
    queue.start();
    const job = await queue.enqueue(selftest);
    await flush();
    const progress = {
      phase: 'processing' as const,
      percent: 40,
      speedBytesPerSecond: null,
      speedRatio: 1,
      etaSeconds: 6,
    };
    calls[0]?.context.reportProgress(progress);

    expect(events.at(-1)).toEqual({ type: 'job.progress', jobId: job.id, progress });
    expect(queue.get(job.id)?.progress).toEqual(progress);
  });

  it('limita la frecuencia del progreso pero siempre envía el último valor', async () => {
    vi.useFakeTimers();
    const { queue, calls, events } = setup({ progressIntervalMs: 250 });
    queue.start();
    const job = await queue.enqueue(selftest);
    await vi.advanceTimersByTimeAsync(0);
    const report = (percent: number) => {
      calls[0]?.context.reportProgress({
        phase: 'processing',
        percent,
        speedBytesPerSecond: null,
        speedRatio: null,
        etaSeconds: null,
      });
    };
    report(1);
    report(2);
    report(3);
    const sent = () =>
      events.flatMap((e) => (e.type === 'job.progress' ? [e.progress.percent] : []));
    expect(sent()).toEqual([1]);

    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toEqual([1, 3]);
    expect(job.id).toBeDefined();
  });
});
