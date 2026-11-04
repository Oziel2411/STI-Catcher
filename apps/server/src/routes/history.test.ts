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
import { CLIENT_COOKIE, readClientId } from '../http/client-id.ts';

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';
const cookie = (clientId: string) => ({ cookie: `${CLIENT_COOKIE}=${clientId}` });

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app() {
  const testApp = await makeTestApp();
  storageDirs.push(testApp.storageDir);
  const events: JobEvent[] = [];
  // Cada evento publicado se valida con el contrato de shared, igual que en el navegador.
  testApp.bus.subscribe((event) => events.push(jobEventSchema.parse(event)));
  return { ...testApp, events };
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

function createJob(testApp: Awaited<ReturnType<typeof app>>, title: string, clientId: string) {
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
    clientId,
    clientIp: '10.0.0.7',
    createdAt: new Date().toISOString(),
  });
  return job.id;
}

describe('cookie clientId', () => {
  it('un navegador sin cookie recibe una nueva, HttpOnly y SameSite=Lax', async () => {
    const { app: server } = await app();
    const response = await server.inject({ method: 'GET', url: '/api/history' });
    const setCookie = String(response.headers['set-cookie']);
    expect(readClientId(setCookie.split(';')[0])).not.toBeNull();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure'); // sin HTTPS
  });

  it('respeta la cookie existente; una inválida se reemplaza', async () => {
    const { app: server } = await app();
    const kept = await server.inject({
      method: 'GET',
      url: '/api/history',
      headers: cookie(CLIENT_A),
    });
    expect(String(kept.headers['set-cookie'])).toContain(`${CLIENT_COOKIE}=${CLIENT_A}`);
    const replaced = await server.inject({
      method: 'GET',
      url: '/api/history',
      headers: { cookie: `${CLIENT_COOKIE}=no-es-uuid` },
    });
    expect(String(replaced.headers['set-cookie'])).not.toContain('no-es-uuid');
  });
});

describe('GET /api/history', () => {
  it('"mine" muestra solo los de este navegador; "all" todos, con isMine', async () => {
    const testApp = await app();
    const mine = createJob(testApp, 'Mío', CLIENT_A);
    const other = createJob(testApp, 'De otro', CLIENT_B);

    const own = historyResponseSchema.parse(
      (
        await testApp.app.inject({ method: 'GET', url: '/api/history', headers: cookie(CLIENT_A) })
      ).json(),
    );
    expect(own.items.map((i) => i.id)).toEqual([mine]);
    expect(own.items[0]?.isMine).toBe(true);

    const all = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/history?scope=all',
          headers: cookie(CLIENT_A),
        })
      ).json(),
    );
    expect(all.total).toBe(2);
    expect(Object.fromEntries(all.items.map((i) => [i.id, i.isMine]))).toEqual({
      [mine]: true,
      [other]: false,
    });
  });

  it('nunca expone el clientId; quién lo pidió va solo como PC o IP (D-098)', async () => {
    const testApp = await app();
    createJob(testApp, 'x', CLIENT_A);
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/history',
      headers: cookie(CLIENT_A),
    });
    expect(response.body).not.toContain(CLIENT_A);
    // Sin nombre de PC resuelto, se muestra la IP (es el filtro "Usuario").
    expect(historyResponseSchema.parse(response.json()).items[0]?.requester).toBe('10.0.0.7');
  });

  it('busca sin tildes y pagina', async () => {
    const testApp = await app();
    createJob(testApp, 'Canción', CLIENT_A);
    createJob(testApp, 'Otra cosa', CLIENT_A);
    const found = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: `/api/history?q=${encodeURIComponent('cancion')}`,
          headers: cookie(CLIENT_A),
        })
      ).json(),
    );
    expect(found.items.map((i) => i.title)).toEqual(['Canción']);

    const page2 = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/history?pageSize=1&page=2',
          headers: cookie(CLIENT_A),
        })
      ).json(),
    );
    expect(page2).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page2.items).toHaveLength(1);
  });

  it('un trabajo terminado cuyo archivo ya no está aparece como expirado (y se avisa por SSE)', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Borrado a mano', CLIENT_A);
    forceDone(testApp, jobId, false);
    const response = historyResponseSchema.parse(
      (
        await testApp.app.inject({ method: 'GET', url: '/api/history', headers: cookie(CLIENT_A) })
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
    const jobId = createJob(testApp, 'Mío', CLIENT_A);
    forceDone(testApp, jobId);
    const response = await testApp.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}`,
      headers: cookie(CLIENT_A),
    });
    expect(response.statusCode).toBe(204);
    expect(testApp.repo.get(jobId)).toBeNull();
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(testApp.filesDir, `${jobId}.mp4`))).toBe(false);
    expect(testApp.events).toContainEqual({ type: 'job.deleted', jobId });
    expect(testApp.historyLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId, deletedByIp: '127.0.0.1', createdByIp: '10.0.0.7' }),
      'Trabajo borrado del historial',
    );
  });

  it('403 si el trabajo es de otro navegador', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'De otro', CLIENT_B);
    forceDone(testApp, jobId);
    const response = await testApp.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}`,
      headers: cookie(CLIENT_A),
    });
    expect(response.statusCode).toBe(403);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_OWNER');
    expect(testApp.repo.get(jobId)).not.toBeNull();
  });

  it('409 si está en curso; 404 si no existe', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'En cola', CLIENT_A);
    expect(
      (
        await testApp.app.inject({
          method: 'DELETE',
          url: `/api/jobs/${jobId}`,
          headers: cookie(CLIENT_A),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await testApp.app.inject({
          method: 'DELETE',
          url: '/api/jobs/00000000-0000-4000-8000-999999999999',
          headers: cookie(CLIENT_A),
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('POST /api/jobs/:id/retry', () => {
  it('crea un trabajo nuevo con los mismos parámetros, a nombre de quien reintenta', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Falló', CLIENT_B);
    testApp.repo.markRunning(jobId, now());
    testApp.repo.finish(jobId, { status: 'failed', finishedAt: now(), error: 'x' });

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/retry`,
      headers: cookie(CLIENT_A),
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
      clientId: CLIENT_A,
    });
    expect(testApp.repo.get(jobId)?.status).toBe('failed');
  });

  it('409 si el trabajo no falló ni se canceló', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Bien', CLIENT_A);
    forceDone(testApp, jobId);
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/retry`,
      headers: cookie(CLIENT_A),
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('GET /api/jobs/:id/file?inline=1', () => {
  it('se puede reproducir en el navegador, con Range', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Canción', CLIENT_A);
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
    const jobId = createJob(testApp, 'x', CLIENT_A);
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
    const insert = (type: 'download' | 'conversion' | 'recording', clientId: string) =>
      testApp.repo.insert({
        id: crypto.randomUUID(),
        type,
        params: {},
        clientId,
        createdAt: now(),
      });

    // De este navegador: dos descargas (una ya terminó y tiene su conversión en curso),
    // una conversión hecha a mano y una grabación procesándose.
    const queued = insert('download', CLIENT_A);
    const downloaded = insert('download', CLIENT_A);
    const followUp = insert('conversion', CLIENT_A);
    testApp.repo.markRunning(downloaded.id, now());
    testApp.repo.finish(downloaded.id, { status: 'done', finishedAt: now() });
    testApp.repo.setFollowUp(downloaded.id, followUp.id);
    insert('conversion', CLIENT_A);
    const recording = insert('recording', CLIENT_A);
    testApp.repo.markRunning(recording.id, now());
    // Terminados y de otro navegador: no cuentan.
    const done = insert('conversion', CLIENT_A);
    testApp.repo.finish(done.id, { status: 'cancelled', finishedAt: now() });
    insert('download', CLIENT_B);
    expect(queued.status).toBe('queued');

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/active-jobs',
      headers: cookie(CLIENT_A),
    });
    expect(response.statusCode).toBe(200);
    expect(activeJobsResponseSchema.parse(response.json())).toEqual({
      download: 2,
      conversion: 1,
      recording: 1,
    });
  });

  it('un navegador nuevo ve todo en cero', async () => {
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
    const download = async (remoteAddress: string) => {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/jobs/download',
        payload: { url: 'https://youtu.be/x' },
        remoteAddress,
      });
      return createJobResponseSchema.parse(response.json()).jobId;
    };
    const fromSala = await download('10.0.0.5');
    const unknown = await download('10.0.0.6');
    // La resolución corre en segundo plano.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(testApp.repo.get(fromSala)?.clientHost).toBe('PC-SALA');
    expect(testApp.repo.get(unknown)?.clientHost).toBeNull();

    const history = async (query: string) => {
      const response = await testApp.app.inject({ method: 'GET', url: `/api/history?${query}` });
      expect(response.statusCode).toBe(200);
      return historyResponseSchema.parse(response.json()).items;
    };

    const all = await history('scope=all');
    expect(all.map((item) => [item.id, item.requester])).toEqual([
      [unknown, '10.0.0.6'],
      [fromSala, 'PC-SALA'],
    ]);
    expect((await history('scope=all&user=PC-SALA')).map((item) => item.id)).toEqual([fromSala]);
    expect(await history('scope=all&type=conversion,recording')).toEqual([]);
    expect(await history('scope=all&type=download')).toHaveLength(2);
    expect(await history('scope=all&from=2099-01-01T00:00:00.000Z')).toEqual([]);
    expect(await history('scope=all&to=2000-01-01T00:00:00.000Z')).toEqual([]);

    const requesters = await testApp.app.inject({ method: 'GET', url: '/api/history/requesters' });
    expect(historyRequestersResponseSchema.parse(requesters.json()).requesters).toEqual([
      { value: '10.0.0.6', label: '10.0.0.6', total: 1 },
      { value: 'PC-SALA', label: 'PC-SALA', total: 1 },
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
