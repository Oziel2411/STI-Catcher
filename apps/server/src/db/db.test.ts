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
    expect(migrate(db, migrations).map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    expect(migrate(db, migrations)).toEqual([]);
    expect(db.pragma('user_version', { simple: true })).toBe(5);
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
    db.pragma('user_version = 99');
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

describe('historial (repositorio)', () => {
  const CLIENT_A = '11111111-1111-4111-8111-111111111111';
  const CLIENT_B = '22222222-2222-4222-8222-222222222222';
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const types = ['download', 'upload', 'conversion', 'recording'] as const;

  function seeded() {
    const repo = createJobsRepository(freshDb());
    const add = (
      n: number,
      title: string,
      clientId: string,
      type: 'download' | 'selftest' = 'download',
    ) =>
      repo.insert({
        id: id(n),
        type,
        params: {},
        title,
        clientId,
        createdAt: `2026-10-29T12:00:${String(n).padStart(2, '0')}.000Z`,
      });
    add(1, 'Canción del Ñandú', CLIENT_A);
    add(2, 'Big Buck Bunny', CLIENT_B);
    add(3, 'cancion_sin_tilde 100%', CLIENT_A);
    add(4, 'Prueba del sistema (10 s)', CLIENT_A, 'selftest');
    return repo;
  }

  const ids = (result: { records: { id: string }[] }) => result.records.map((r) => r.id);

  it('lista del más nuevo al más viejo, sin el selftest, con el total', () => {
    const result = seeded().listHistory({
      types,
      clientId: null,
      search: null,
      limit: 10,
      offset: 0,
    });
    expect(ids(result)).toEqual([id(3), id(2), id(1)]);
    expect(result.total).toBe(3);
  });

  it('"Mis trabajos" filtra por navegador', () => {
    const result = seeded().listHistory({
      types,
      clientId: CLIENT_A,
      search: null,
      limit: 10,
      offset: 0,
    });
    expect(ids(result)).toEqual([id(3), id(1)]);
  });

  it('busca sin distinguir mayúsculas ni tildes', () => {
    const repo = seeded();
    const search = (text: string) =>
      ids(repo.listHistory({ types, clientId: null, search: text, limit: 10, offset: 0 }));
    expect(search('CANCION')).toEqual([id(3), id(1)]);
    expect(search('ñandu')).toEqual([id(1)]);
    expect(search('bunny')).toEqual([id(2)]);
  });

  it('% y _ en la búsqueda se toman literalmente', () => {
    const repo = seeded();
    expect(
      ids(repo.listHistory({ types, clientId: null, search: '100%', limit: 10, offset: 0 })),
    ).toEqual([id(3)]);
    expect(
      ids(repo.listHistory({ types, clientId: null, search: '_', limit: 10, offset: 0 })),
    ).toEqual([id(3)]);
  });

  it('pagina con limit y offset; el total no depende de la página', () => {
    const result = seeded().listHistory({
      types,
      clientId: null,
      search: null,
      limit: 2,
      offset: 2,
    });
    expect(ids(result)).toEqual([id(1)]);
    expect(result.total).toBe(3);
  });

  it('el título que informa el job al terminar también se puede buscar', () => {
    const repo = seeded();
    repo.markRunning(id(2), 't');
    repo.finish(id(2), { status: 'done', finishedAt: 't', title: 'Título Nuevo Ácido' });
    expect(
      ids(repo.listHistory({ types, clientId: null, search: 'acido', limit: 10, offset: 0 })),
    ).toEqual([id(2)]);
  });

  it('filtra por fecha (desde inclusive, hasta exclusive), tipo y quién lo pidió', () => {
    const repo = seeded();
    // 1 y 3 desde la misma PC; 2 sin nombre resuelto (queda la IP).
    for (const [n, ip] of [
      [1, '192.168.3.40'],
      [2, '192.168.3.41'],
      [3, '192.168.3.40'],
    ] as const) {
      repo.insert({
        id: id(10 + n),
        type: n === 2 ? 'conversion' : 'recording',
        params: {},
        title: `Extra ${String(n)}`,
        clientIp: ip,
        createdAt: `2026-10-30T0${String(n)}:00:00.000Z`,
      });
    }
    repo.setClientHost(id(11), 'PC-SALA');
    repo.setClientHost(id(13), 'PC-SALA');
    const list = (filter: Partial<Parameters<typeof repo.listHistory>[0]>) =>
      ids(
        repo.listHistory({ types, clientId: null, search: null, limit: 20, offset: 0, ...filter }),
      );

    expect(list({ from: '2026-10-30T02:00:00.000Z' })).toEqual([id(13), id(12)]);
    expect(list({ from: '2026-10-30T00:00:00.000Z', to: '2026-10-30T02:00:00.000Z' })).toEqual([
      id(11),
    ]);
    expect(list({ types: ['conversion'] })).toEqual([id(12)]);
    expect(list({ requester: 'PC-SALA' })).toEqual([id(13), id(11)]);
    expect(list({ requester: '192.168.3.41' })).toEqual([id(12)]);

    expect(repo.listRequesters(types)).toEqual([
      { value: 'PC-SALA', total: 2 },
      { value: '192.168.3.41', total: 1 },
    ]);
  });

  it('markExpired solo pasa de done a expired', () => {
    const repo = seeded();
    expect(repo.markExpired(id(1))).toBe(false); // queued
    repo.markRunning(id(1), 't');
    repo.finish(id(1), { status: 'done', finishedAt: 't' });
    expect(repo.markExpired(id(1))).toBe(true);
    expect(repo.get(id(1))?.status).toBe('expired');
    expect(repo.markExpired(id(1))).toBe(false);
  });

  it('delete no borra trabajos activos', () => {
    const repo = seeded();
    expect(repo.delete(id(1))).toBe(false); // queued
    repo.markRunning(id(1), 't');
    repo.finish(id(1), { status: 'failed', finishedAt: 't', error: 'x' });
    expect(repo.delete(id(1))).toBe(true);
    expect(repo.get(id(1))).toBeNull();
  });

  it('la migración 2 completa la búsqueda de los trabajos que ya existían', () => {
    const db = openDatabase(':memory:');
    migrate(
      db,
      migrations.filter((m) => m.version === 1),
    );
    db.prepare(
      "INSERT INTO jobs (id, type, status, created_at, title) VALUES ('x', 'download', 'done', 't', 'Canción Vieja')",
    ).run();
    migrate(db, migrations);
    const row = db
      .prepare<[], { title_search: string }>("SELECT title_search FROM jobs WHERE id = 'x'")
      .get();
    expect(row?.title_search).toBe('cancion vieja');
  });
});
