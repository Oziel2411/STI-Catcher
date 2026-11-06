import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  apiErrorSchema,
  createJobResponseSchema,
  activeJobsResponseSchema,
  historyRequestersResponseSchema,
  historyResponseSchema,
  jobEventSchema,
} from '@sti-catcher/shared';
import type { JobEvent } from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test/test-app.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app() {
  const testApp = await makeTestApp();
  storageDirs.push(testApp.storageDir);
  // Dos cuentas: «ana» (la sesión por defecto de los pedidos) y «beto».
  const beto = await testApp.loginAs('beto@capitanes.ar');
  const events: JobEvent[] = [];
  // Cada evento publicado se valida con el contrato de shared, igual que en el navegador.
  testApp.bus.subscribe((event) => events.push(jobEventSchema.parse(event)));
  return { ...testApp, beto, events };
}

const now = () => new Date().toISOString();

/** Deja un job en done con archivo, sin pasar por la cola (más simple que un runner). */
function forceDone(testApp: Awaited<ReturnType<typeof app>>, jobId: string, withFile = true) {
  const db = testApp.repo;
  db.markRunning(jobId, now());
  db.finish(jobId, { status: 'done', finishedAt: now(), filePath: `files/${jobId}.mp4` });
  if (withFile) {
    mkdirSync(testApp.filesDir, { recursive: true });
    writeFileSync(path.join(testApp.filesDir, `${jobId}.mp4`), Buffer.alloc(1000, 1));
  }
}

function createJob(testApp: Awaited<ReturnType<typeof app>>, title: string, userId: string | null) {
  const job = testApp.repo.insert({
    id: crypto.randomUUID(),
    type: 'download',
    params: {
      url: 'https://www.youtube.com/watch?v=x',
      format: 'mp4',
      maxHeight: 360,
      videoMode: 'compat',
    },
    title,
    sourceUrl: 'https://www.youtube.com/watch?v=x',
    userId,
    clientIp: '10.0.0.7',
    createdAt: new Date().toISOString(),
  });
  return job.id;
}

describe('GET /api/history', () => {
  it('"mine" muestra solo los de la cuenta; "all" todos, con isMine', async () => {
    const testApp = await app();
    const mine = createJob(testApp, 'Mío', testApp.ana.user.id);
    const other = createJob(testApp, 'De otro', testApp.beto.user.id);

    const own = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/history',
          headers: testApp.ana.headers,
        })
      ).json(),
    );
    expect(own.items.map((i) => i.id)).toEqual([mine]);
    expect(own.items[0]?.isMine).toBe(true);

    const all = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/history?scope=all',
          headers: testApp.ana.headers,
        })
      ).json(),
    );
    expect(all.total).toBe(2);
    expect(Object.fromEntries(all.items.map((i) => [i.id, i.isMine]))).toEqual({
      [mine]: true,
      [other]: false,
    });
  });

  it('quién lo pidió: el nombre de la cuenta; en los de antes del login, la PC o IP', async () => {
    const testApp = await app();
    const mine = createJob(testApp, 'x', testApp.ana.user.id);
    const legacy = createJob(testApp, 'viejo', null);
    const response = await testApp.app.inject({ method: 'GET', url: '/api/history?scope=all' });
    // Ni el mail ni el id de la cuenta salen en el historial.
    expect(response.body).not.toContain('ana@capitanes.ar');
    expect(response.body).not.toContain(testApp.ana.user.id);
    const items = historyResponseSchema.parse(response.json()).items;
    expect(Object.fromEntries(items.map((i) => [i.id, [i.requester, i.isMine]]))).toEqual({
      [mine]: ['ana', true],
      // Sin nombre de PC resuelto, se muestra la IP (D-098). No es de nadie.
      [legacy]: ['10.0.0.7', false],
    });
  });

  it('busca sin tildes y pagina', async () => {
    const testApp = await app();
    createJob(testApp, 'Canción', testApp.ana.user.id);
    createJob(testApp, 'Otra cosa', testApp.ana.user.id);
    const found = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: `/api/history?q=${encodeURIComponent('cancion')}`,
          headers: testApp.ana.headers,
        })
      ).json(),
    );
    expect(found.items.map((i) => i.title)).toEqual(['Canción']);

    const page2 = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/history?pageSize=1&page=2',
          headers: testApp.ana.headers,
        })
      ).json(),
    );
    expect(page2).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page2.items).toHaveLength(1);
  });

  it('un trabajo terminado cuyo archivo ya no está aparece como expirado (y se avisa por SSE)', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Borrado a mano', testApp.ana.user.id);
    forceDone(testApp, jobId, false);
    const response = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/history',
          headers: testApp.ana.headers,
        })
      ).json(),
    );
    expect(response.items[0]?.status).toBe('expired');
    expect(testApp.repo.get(jobId)?.status).toBe('expired');
    expect(
      testApp.events.some(
        (e) => e.type === 'job.updated' && e.job.id === jobId && e.job.status === 'expired',
      ),
    ).toBe(true);
  });
});

describe('DELETE /api/jobs/:id', () => {
  it('borra un trabajo propio y su archivo, lo publica y lo registra con la IP', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Mío', testApp.ana.user.id);
    forceDone(testApp, jobId);
    const response = await testApp.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}`,
      headers: testApp.ana.headers,
    });
    expect(response.statusCode).toBe(204);
    expect(testApp.repo.get(jobId)).toBeNull();
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(testApp.filesDir, `${jobId}.mp4`))).toBe(false);
    expect(testApp.events).toContainEqual({ type: 'job.deleted', jobId });
    expect(testApp.historyLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        deletedByUser: testApp.ana.user.id,
        deletedByIp: '127.0.0.1',
        createdByIp: '10.0.0.7',
      }),
      'Trabajo borrado del historial',
    );
  });

  it('403 si el trabajo es de otra persona, o de antes del login', async () => {
    const testApp = await app();
    for (const owner of [testApp.beto.user.id, null]) {
      const jobId = createJob(testApp, 'De otro', owner);
      forceDone(testApp, jobId);
      const response = await testApp.app.inject({
        method: 'DELETE',
        url: `/api/jobs/${jobId}`,
        headers: testApp.ana.headers,
      });
      expect(response.statusCode).toBe(403);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_OWNER');
      expect(testApp.repo.get(jobId)).not.toBeNull();
    }
  });

  it('409 si está en curso; 404 si no existe', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'En cola', testApp.ana.user.id);
    expect(
      (
        await testApp.app.inject({
          method: 'DELETE',
          url: `/api/jobs/${jobId}`,
          headers: testApp.ana.headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await testApp.app.inject({
          method: 'DELETE',
          url: '/api/jobs/00000000-0000-4000-8000-999999999999',
          headers: testApp.ana.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('POST /api/jobs/:id/retry', () => {
  it('crea un trabajo nuevo con los mismos parámetros, a nombre de quien reintenta', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Falló', testApp.beto.user.id);
    testApp.repo.markRunning(jobId, now());
    testApp.repo.finish(jobId, { status: 'failed', finishedAt: now(), error: 'x' });

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/retry`,
      headers: testApp.ana.headers,
    });
    expect(response.statusCode).toBe(202);
    const { jobId: newId } = createJobResponseSchema.parse(response.json());
    expect(newId).not.toBe(jobId);
    expect(testApp.repo.get(newId)).toMatchObject({
      type: 'download',
      title: 'Falló',
      sourceUrl: 'https://www.youtube.com/watch?v=x',
      params: {
        url: 'https://www.youtube.com/watch?v=x',
        format: 'mp4',
        maxHeight: 360,
        videoMode: 'compat',
      },
      userId: testApp.ana.user.id,
    });
    expect(testApp.repo.get(jobId)?.status).toBe('failed');
  });

  it('409 si el trabajo no falló ni se canceló', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Bien', testApp.ana.user.id);
    forceDone(testApp, jobId);
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/retry`,
      headers: testApp.ana.headers,
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('GET /api/jobs/:id/file?inline=1', () => {
  it('se puede reproducir en el navegador, con Range', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Canción', testApp.ana.user.id);
    forceDone(testApp, jobId);
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/file?inline=1`,
      headers: { range: 'bytes=0-99' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(String(response.headers['content-disposition'])).toMatch(
      /^inline; .*filename\*=UTF-8''Canci%C3%B3n\.mp4$/,
    );
  });

  it('si el archivo desapareció: 410 y el trabajo pasa a expirado', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'x', testApp.ana.user.id);
    forceDone(testApp, jobId, false);
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/file?inline=1`,
    });
    expect(response.statusCode).toBe(410);
    expect(testApp.repo.get(jobId)?.status).toBe('expired');
  });
});

describe('GET /api/active-jobs', () => {
  it('cuenta lo propio en cola o en curso; la conversión encadenada cuenta como descarga', async () => {
    const testApp = await app();
    const insert = (type: 'download' | 'conversion' | 'recording', userId: string) =>
      testApp.repo.insert({
        id: crypto.randomUUID(),
        type,
        params: {},
        userId,
        createdAt: now(),
      });

    // De esta cuenta: dos descargas (una ya terminó y tiene su conversión en curso),
    // una conversión hecha a mano y una grabación procesándose.
    const queued = insert('download', testApp.ana.user.id);
    const downloaded = insert('download', testApp.ana.user.id);
    const followUp = insert('conversion', testApp.ana.user.id);
    testApp.repo.markRunning(downloaded.id, now());
    testApp.repo.finish(downloaded.id, { status: 'done', finishedAt: now() });
    testApp.repo.setFollowUp(downloaded.id, followUp.id);
    insert('conversion', testApp.ana.user.id);
    const recording = insert('recording', testApp.ana.user.id);
    testApp.repo.markRunning(recording.id, now());
    // Terminados y de otra cuenta: no cuentan.
    const done = insert('conversion', testApp.ana.user.id);
    testApp.repo.finish(done.id, { status: 'cancelled', finishedAt: now() });
    insert('download', testApp.beto.user.id);
    expect(queued.status).toBe('queued');

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/active-jobs',
      headers: testApp.ana.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(activeJobsResponseSchema.parse(response.json())).toEqual({
      download: 2,
      conversion: 1,
      recording: 1,
    });
  });

  it('una cuenta sin trabajos ve todo en cero', async () => {
    const testApp = await app();
    const response = await testApp.app.inject({ method: 'GET', url: '/api/active-jobs' });
    expect(response.json()).toEqual({ download: 0, conversion: 0, recording: 0 });
  });
});

describe('filtros del historial', () => {
  it('guarda el nombre de la PC del pedido y filtra por fecha, tipo y usuario', async () => {
    const testApp = await makeTestApp({
      resolveHost: (ip) => Promise.resolve(ip === '10.0.0.5' ? 'PC-SALA' : null),
    });
    storageDirs.push(testApp.storageDir);
    const beto = await testApp.loginAs('beto@capitanes.ar');
    // Un trabajo de antes del login (sin cuenta), pedido desde una PC sin nombre.
    const legacy = testApp.repo.insert({
      id: crypto.randomUUID(),
      type: 'download',
      params: {},
      clientIp: '10.0.0.7',
      createdAt: '2026-01-01T00:00:00.000Z',
    }).id;
    const download = async (remoteAddress: string, headers: Record<string, string>) => {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/jobs/download',
        payload: { url: 'https://youtu.be/x' },
        remoteAddress,
        headers,
      });
      return createJobResponseSchema.parse(response.json()).jobId;
    };
    const fromAna = await download('10.0.0.5', testApp.ana.headers);
    const fromBeto = await download('10.0.0.6', beto.headers);
    // La resolución corre en segundo plano. El nombre de la PC se sigue guardando.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(testApp.repo.get(fromAna)?.clientHost).toBe('PC-SALA');
    expect(testApp.repo.get(fromBeto)?.clientHost).toBeNull();

    const history = async (query: string) => {
      const response = await testApp.app.inject({ method: 'GET', url: `/api/history?${query}` });
      expect(response.statusCode).toBe(200);
      return historyResponseSchema.parse(response.json()).items;
    };

    // El usuario es la cuenta (D-100), no la PC.
    const all = await history('scope=all');
    expect(Object.fromEntries(all.map((item) => [item.id, item.requester]))).toEqual({
      [fromAna]: 'ana',
      [fromBeto]: 'beto',
      [legacy]: '10.0.0.7',
    });
    const anaValue = `user:${testApp.ana.user.id}`;
    expect((await history(`scope=all&user=${anaValue}`)).map((item) => item.id)).toEqual([fromAna]);
    expect((await history('scope=all&user=10.0.0.7')).map((item) => item.id)).toEqual([legacy]);
    expect(await history('scope=all&type=conversion,recording')).toEqual([]);
    expect(await history('scope=all&type=download')).toHaveLength(3);
    expect(await history('scope=all&from=2099-01-01T00:00:00.000Z')).toEqual([]);
    expect(await history('scope=all&to=2000-01-01T00:00:00.000Z')).toEqual([]);

    const requesters = await testApp.app.inject({ method: 'GET', url: '/api/history/requesters' });
    const values = historyRequestersResponseSchema.parse(requesters.json()).requesters;
    // El más viejo al final; ana y beto pueden empatar en el mismo milisegundo.
    expect(values.at(-1)).toEqual({ value: '10.0.0.7', label: '10.0.0.7', total: 1 });
    expect(values.slice(0, 2).sort((a, b) => a.label.localeCompare(b.label))).toEqual([
      { value: anaValue, label: 'ana', total: 1 },
      { value: `user:${beto.user.id}`, label: 'beto', total: 1 },
    ]);
  });

  it('400 con un tipo o una fecha que no sirven', async () => {
    const testApp = await app();
    for (const query of ['type=selftest', 'type=exe', 'from=ayer']) {
      const response = await testApp.app.inject({ method: 'GET', url: `/api/history?${query}` });
      expect(response.statusCode).toBe(400);
    }
  });
});
