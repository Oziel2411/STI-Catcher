import { describe, expect, it } from 'vitest';
import { openDatabase } from './connection.ts';
import { createJobsRepository } from './jobs-repository.ts';
import { migrate } from './migrate.ts';
import type { Migration } from './migrate.ts';
import { migrations } from './migrations.ts';

const ids = {
  a: '00000000-0000-4000-8000-00000000000a',
  b: '00000000-0000-4000-8000-00000000000b',
  c: '00000000-0000-4000-8000-00000000000c',
};

function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db, migrations);
  return db;
}

describe('migrate', () => {
  it('aplica las pendientes una sola vez', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db, migrations).map((m) => m.version)).toEqual([1]);
    expect(migrate(db, migrations)).toEqual([]);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });

  it('revierte una migración que falla y no avanza la versión', () => {
    const db = openDatabase(':memory:');
    const broken: Migration[] = [
      { version: 1, name: 'ok', sql: 'CREATE TABLE a (x INTEGER);' },
      { version: 2, name: 'rota', sql: 'CREATE TABLE b (x INTEGER); SELECT * FROM no_existe;' },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    // La tabla b no quedó creada a medias.
    expect(() => db.prepare('SELECT * FROM b').all()).toThrow();
  });

  it('rechaza numeración con huecos', () => {
    const db = openDatabase(':memory:');
    expect(() => migrate(db, [{ version: 2, name: 'x', sql: '' }])).toThrow(/mal numeradas/);
  });

  it('rechaza una base más nueva que el código', () => {
    const db = openDatabase(':memory:');
    db.pragma('user_version = 5');
    expect(() => migrate(db, migrations)).toThrow(/más nueva/);
  });
});

describe('jobs repository', () => {
  it('inserta en estado queued y guarda los params como JSON', () => {
    const repo = createJobsRepository(freshDb());
    const job = repo.insert({
      id: ids.a,
      type: 'selftest',
      params: { durationSeconds: 10 },
      createdAt: '2026-10-29T12:00:00.000Z',
      clientIp: '10.0.0.5',
    });
    expect(job).toMatchObject({
      id: ids.a,
      status: 'queued',
      params: { durationSeconds: 10 },
      clientIp: '10.0.0.5',
      startedAt: null,
    });
    expect(repo.get(ids.a)).toEqual(job);
    expect(repo.get(ids.b)).toBeNull();
  });

  it('entrega la cola por orden de llegada', () => {
    const repo = createJobsRepository(freshDb());
    const t = '2026-10-29T12:00:00.000Z';
    // Mismo created_at: desempata el orden de inserción.
    repo.insert({ id: ids.b, type: 'selftest', params: {}, createdAt: t });
    repo.insert({ id: ids.a, type: 'selftest', params: {}, createdAt: t });
    expect(repo.nextQueued()?.id).toBe(ids.b);
    repo.markRunning(ids.b, t);
    expect(repo.nextQueued()?.id).toBe(ids.a);
  });

  it('solo permite transiciones válidas', () => {
    const repo = createJobsRepository(freshDb());
    const t = '2026-10-29T12:00:00.000Z';
    repo.insert({ id: ids.a, type: 'selftest', params: {}, createdAt: t });

    expect(repo.markRunning(ids.a, t)).toBe(true);
    expect(repo.markRunning(ids.a, t)).toBe(false); // ya no está queued
    expect(repo.finish(ids.a, { status: 'done', finishedAt: t, sizeBytes: 123 })).toBe(true);
    expect(repo.finish(ids.a, { status: 'cancelled', finishedAt: t })).toBe(false); // ya terminó
    expect(repo.get(ids.a)).toMatchObject({ status: 'done', sizeBytes: 123 });
  });

  it('una cancelación gana a un arranque posterior', () => {
    const repo = createJobsRepository(freshDb());
    const t = '2026-10-29T12:00:00.000Z';
    repo.insert({ id: ids.a, type: 'selftest', params: {}, createdAt: t });
    expect(repo.finish(ids.a, { status: 'cancelled', finishedAt: t })).toBe(true);
    expect(repo.markRunning(ids.a, t)).toBe(false);
  });

  it('failAllRunning marca solo los running y devuelve sus ids', () => {
    const repo = createJobsRepository(freshDb());
    const t = '2026-10-29T12:00:00.000Z';
    for (const id of [ids.a, ids.b, ids.c]) {
      repo.insert({ id, type: 'selftest', params: {}, createdAt: t });
    }
    repo.markRunning(ids.a, t);
    repo.markRunning(ids.b, t);

    expect(repo.failAllRunning('Interrumpido', t)).toEqual([ids.a, ids.b]);
    expect(repo.get(ids.a)).toMatchObject({ status: 'failed', error: 'Interrumpido' });
    expect(repo.get(ids.c)?.status).toBe('queued');
    expect(repo.countActive()).toEqual({ queued: 1, running: 0 });
  });

  it('lista con filtros, del más nuevo al más viejo', () => {
    const repo = createJobsRepository(freshDb());
    repo.insert({ id: ids.a, type: 'selftest', params: {}, createdAt: '2026-10-29T10:00:00.000Z' });
    repo.insert({ id: ids.b, type: 'download', params: {}, createdAt: '2026-10-29T11:00:00.000Z' });
    repo.insert({ id: ids.c, type: 'selftest', params: {}, createdAt: '2026-10-29T12:00:00.000Z' });
    repo.markRunning(ids.c, '2026-10-29T12:00:00.000Z');

    expect(repo.list({ limit: 10 }).map((j) => j.id)).toEqual([ids.c, ids.b, ids.a]);
    expect(repo.list({ types: ['selftest'], limit: 10 }).map((j) => j.id)).toEqual([ids.c, ids.a]);
    expect(
      repo.list({ statuses: ['queued'], types: ['selftest'], limit: 10 }).map((j) => j.id),
    ).toEqual([ids.a]);
    expect(repo.list({ limit: 1 })).toHaveLength(1);
  });

  it('rechaza tipos o estados inválidos a nivel de base', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO jobs (id, type, status, created_at) VALUES ('x', 'otro', 'queued', 't')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
