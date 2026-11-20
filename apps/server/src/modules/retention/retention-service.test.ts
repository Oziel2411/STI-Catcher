import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/connection.ts';
import { createJobsRepository } from '../../db/jobs-repository.ts';
import { migrate } from '../../db/migrate.ts';
import { migrations } from '../../db/migrations.ts';
import { createRetentionService } from './retention-service.ts';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 3600 * 1000);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(retentionDays = 14) {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'sti-retention-'));
  dirs.push(storageDir);
  const filesDir = path.join(storageDir, 'files');
  const recordingsDir = path.join(storageDir, 'recordings');
  mkdirSync(filesDir);
  mkdirSync(recordingsDir);
  const db = openDatabase(':memory:');
  migrate(db, migrations);
  const repo = createJobsRepository(db);
  const logger = { info: vi.fn(), warn: vi.fn() };

  /** Un archivo con fecha de modificación de hace `age` días. */
  const file = (dir: string, name: string, age: number) => {
    const full = path.join(dir, name);
    writeFileSync(full, 'x');
    utimesSync(full, daysAgo(age), daysAgo(age));
    return full;
  };
  /** Un job done con su archivo, terminado hace `age` días. */
  const doneJob = (n: number, age: number, parentJobId?: string) => {
    repo.insert({
      id: id(n),
      type: 'download',
      params: {},
      createdAt: daysAgo(age).toISOString(),
      ...(parentJobId ? { parentJobId } : {}),
    });
    repo.finish(id(n), {
      status: 'done',
      finishedAt: daysAgo(age).toISOString(),
      filePath: `files/${id(n)}.mp4`,
    });
    return file(filesDir, `${id(n)}.mp4`, age);
  };

  const service = createRetentionService({
    retentionDays,
    repo,
    expire: (jobId) => repo.markExpired(jobId),
    storageDir,
    filesDir,
    recordingsDir,
    now: () => NOW,
    logger,
  });
  return { service, repo, filesDir, recordingsDir, file, doneJob, logger };
}

describe('createRetentionService', () => {
  it('borra los archivos de más de N días y deja el job como expirado', async () => {
    const { service, repo, doneJob } = setup(14);
    const old = doneJob(1, 15);
    const recent = doneJob(2, 13);
    expect(await service.run()).toEqual({ expired: 1, orphans: 0, recordings: 0 });
    expect(existsSync(old)).toBe(false);
    expect(repo.get(id(1))?.status).toBe('expired');
    expect(existsSync(recent)).toBe(true);
    expect(repo.get(id(2))?.status).toBe('done');
  });

  it('no borra el origen de una conversión en cola', async () => {
    const { service, repo, doneJob } = setup(14);
    const source = doneJob(1, 30);
    repo.insert({
      id: id(2),
      type: 'conversion',
      params: {},
      createdAt: NOW.toISOString(),
      parentJobId: id(1),
    });
    expect((await service.run()).expired).toBe(0);
    expect(existsSync(source)).toBe(true);
  });

  it('borra huérfanos viejos de files/ y crudos de grabación viejos, no los recientes', async () => {
    const { service, filesDir, recordingsDir, file, doneJob } = setup(14);
    doneJob(1, 2);
    const orphanOld = file(filesDir, `${id(9)}.mp4`, 20);
    const orphanNew = file(filesDir, `${id(8)}.mp4`, 1);
    const rawOld = file(recordingsDir, `${id(7)}.webm`, 15);
    const rawActive = file(recordingsDir, `${id(6)}.webm`, 0);
    expect(await service.run()).toEqual({ expired: 0, orphans: 1, recordings: 1 });
    expect(existsSync(orphanOld)).toBe(false);
    expect(existsSync(orphanNew)).toBe(true);
    expect(existsSync(rawOld)).toBe(false);
    expect(existsSync(rawActive)).toBe(true);
  });

  it('un archivo viejo de un job done reciente no es huérfano', async () => {
    const { service, doneJob } = setup(14);
    // Por ejemplo, yt-dlp puede dejar la fecha de publicación del video.
    const recentJobOldFile = doneJob(1, 1);
    utimesSync(recentJobOldFile, daysAgo(400), daysAgo(400));
    expect(await service.run()).toEqual({ expired: 0, orphans: 0, recordings: 0 });
    expect(existsSync(recentJobOldFile)).toBe(true);
  });

  it('si no se puede borrar, el job sigue done y se reintenta en la próxima pasada', async () => {
    const { repo, doneJob, filesDir, recordingsDir, logger } = setup(14);
    doneJob(1, 20);
    const service = createRetentionService({
      retentionDays: 14,
      repo,
      expire: (jobId) => repo.markExpired(jobId),
      storageDir: path.dirname(filesDir),
      filesDir,
      recordingsDir,
      removeFile: () => Promise.reject(new Error('EBUSY')),
      now: () => NOW,
      logger,
    });
    expect((await service.run()).expired).toBe(0);
    expect(repo.get(id(1))?.status).toBe('done');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('RETENTION_DAYS=0: nunca borra nada', async () => {
    const { service, doneJob, file, recordingsDir } = setup(0);
    const old = doneJob(1, 3000);
    const raw = file(recordingsDir, 'x.webm', 3000);
    expect(await service.run()).toEqual({ expired: 0, orphans: 0, recordings: 0 });
    expect(existsSync(old)).toBe(true);
    expect(existsSync(raw)).toBe(true);
  });
});

describe('papelera en la retención (D-115)', () => {
  it('corre aunque RETENTION_DAYS=0: lo vencido y los archivos sueltos viejos de trash/', async () => {
    const { repo, filesDir, recordingsDir, file, doneJob, logger } = setup(0);
    const storageDir = path.dirname(filesDir);
    const trashDir = path.join(storageDir, 'trash');
    mkdirSync(trashDir);
    // Un job en la papelera con su archivo guardado (viejo, pero lo guarda un job).
    doneJob(1, 30);
    const kept = file(trashDir, `${id(1)}.mp4`, 30);
    repo.moveToTrash(id(1), {
      kind: 'job',
      at: daysAgo(1).toISOString(),
      trashPath: path.join('trash', `${id(1)}.mp4`),
    });
    const looseOld = file(trashDir, 'suelto-viejo.mp4', 8);
    const looseNew = file(trashDir, 'suelto-nuevo.mp4', 1);
    const purgeExpired = vi.fn(() => Promise.resolve(2));
    const service = createRetentionService({
      retentionDays: 0,
      repo,
      expire: (jobId) => repo.markExpired(jobId),
      storageDir,
      filesDir,
      recordingsDir,
      trash: { days: 7, dir: trashDir, purgeExpired },
      now: () => NOW,
      logger,
    });
    expect(await service.run()).toEqual({ expired: 0, orphans: 0, recordings: 0, trash: 2 });
    expect(purgeExpired).toHaveBeenCalledOnce();
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(looseOld)).toBe(false);
    expect(existsSync(looseNew)).toBe(true);
  });

  it('la retención no toca lo que está en la papelera', async () => {
    const { service, repo, doneJob } = setup(14);
    const old = doneJob(1, 30);
    repo.moveToTrash(id(1), { kind: 'file', at: NOW.toISOString(), trashPath: null });
    expect(await service.run()).toEqual({ expired: 0, orphans: 0, recordings: 0 });
    expect(repo.get(id(1))?.status).toBe('done');
    // El archivo de files/ sigue siendo de un job done: no es huérfano.
    expect(existsSync(old)).toBe(true);
  });
});
