import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  apiErrorSchema,
  createJobResponseSchema,
  activeJobsResponseSchema,
  historyBulkDeleteResponseSchema,
  historyRequestersResponseSchema,
  historyResponseSchema,
  jobEventSchema,
  jobResponseSchema,
  trashEmptyResponseSchema,
  trashResponseSchema,
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
  it('manda un trabajo propio y su archivo a la papelera, lo publica y lo registra con la IP', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Mío', testApp.ana.user.id);
    forceDone(testApp, jobId);
    const response = await testApp.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}`,
      headers: testApp.ana.headers,
    });
    expect(response.statusCode).toBe(204);
    // D-115: la fila queda (en la papelera) y el archivo pasa a trash/.
    expect(testApp.repo.get(jobId)).toMatchObject({ trashKind: 'job', status: 'expired' });
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(testApp.filesDir, `${jobId}.mp4`))).toBe(false);
    expect(existsSync(path.join(testApp.trashDir, `${jobId}.mp4`))).toBe(true);
    expect(testApp.events).toContainEqual({ type: 'job.deleted', jobId });
    expect(testApp.historyLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        deletedByUser: testApp.ana.user.id,
        deletedByIp: '127.0.0.1',
        createdByIp: '10.0.0.7',
      }),
      'Trabajo movido a la papelera',
    );
    // Ya no se ve en el historial, ni se puede volver a borrar.
    const own = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/history',
          headers: testApp.ana.headers,
        })
      ).json(),
    );
    expect(own.items).toEqual([]);
    expect(
      (
        await testApp.app.inject({
          method: 'DELETE',
          url: `/api/jobs/${jobId}`,
          headers: testApp.ana.headers,
        })
      ).statusCode,
    ).toBe(404);
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

/** Una conversión en cola que lee el archivo de `parentJobId`. */
function createChild(testApp: Awaited<ReturnType<typeof app>>, parentJobId: string) {
  return testApp.repo.insert({
    id: crypto.randomUUID(),
    type: 'conversion',
    params: { sourceJobId: parentJobId, preset: 'mp4-h264' },
    title: 'Conversión',
    sourceUrl: null,
    parentJobId,
    userId: testApp.ana.user.id,
    clientIp: '10.0.0.7',
    createdAt: new Date().toISOString(),
  }).id;
}

describe('borrar un archivo que usa otro trabajo (D-113)', () => {
  it('409 SOURCE_IN_USE si una conversión en cola lee el archivo; el archivo queda', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Origen', testApp.ana.user.id);
    forceDone(testApp, jobId);
    createChild(testApp, jobId);
    for (const url of [`/api/jobs/${jobId}`, `/api/jobs/${jobId}/file`]) {
      const response = await testApp.app.inject({
        method: 'DELETE',
        url,
        headers: testApp.ana.headers,
      });
      expect(response.statusCode).toBe(409);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('SOURCE_IN_USE');
    }
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(testApp.filesDir, `${jobId}.mp4`))).toBe(true);
    expect(testApp.repo.get(jobId)?.status).toBe('done');
  });

  it('con la conversión encadenada ya terminada: se borra el origen y la conversión queda intacta', async () => {
    const testApp = await app();
    const download = createJob(testApp, 'Descarga', testApp.ana.user.id);
    forceDone(testApp, download);
    const conversion = createChild(testApp, download);
    forceDone(testApp, conversion);
    expect(testApp.repo.setFollowUp(download, conversion)).toBe(true);
    const { existsSync } = await import('node:fs');

    const fileOnly = await testApp.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${download}/file`,
      headers: testApp.ana.headers,
    });
    expect(fileOnly.statusCode).toBe(200);
    expect(testApp.repo.get(download)?.followUpJobId).toBe(conversion);

    const row = await testApp.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${download}`,
      headers: testApp.ana.headers,
    });
    expect(row.statusCode).toBe(204);
    expect(testApp.repo.get(conversion)).toMatchObject({ status: 'done', parentJobId: download });
    expect(existsSync(path.join(testApp.filesDir, `${conversion}.mp4`))).toBe(true);

    // Borrado para siempre: la conversión sigue, solo pierde el origen (ON DELETE SET NULL).
    const purge = await testApp.app.inject({
      method: 'POST',
      url: '/api/trash/purge',
      headers: testApp.ana.headers,
      payload: { ids: [download] },
    });
    expect(historyBulkDeleteResponseSchema.parse(purge.json()).done).toEqual([download]);
    expect(testApp.repo.get(download)).toBeNull();
    expect(testApp.repo.get(conversion)).toMatchObject({ status: 'done', parentJobId: null });
    expect(existsSync(path.join(testApp.filesDir, `${conversion}.mp4`))).toBe(true);
  });
});

describe('DELETE /api/jobs/:id/file', () => {
  it('manda solo el archivo a la papelera: el trabajo queda expirado, se publica y se registra', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Mío', testApp.ana.user.id);
    forceDone(testApp, jobId);
    const response = await testApp.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}/file`,
      headers: testApp.ana.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(jobResponseSchema.parse(response.json()).job.status).toBe('expired');
    expect(testApp.repo.get(jobId)?.status).toBe('expired');
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(testApp.filesDir, `${jobId}.mp4`))).toBe(false);
    expect(existsSync(path.join(testApp.trashDir, `${jobId}.mp4`))).toBe(true);
    expect(
      testApp.events.some(
        (e) =>
          e.type === 'job.updated' &&
          e.job.id === jobId &&
          e.job.status === 'expired' &&
          e.job.inTrash === true,
      ),
    ).toBe(true);
    expect(testApp.historyLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId, deletedByUser: testApp.ana.user.id }),
      'Archivo movido a la papelera',
    );
  });

  it('403 si es de otra persona; 409 si está en curso o ya no tiene archivo', async () => {
    const testApp = await app();
    const other = createJob(testApp, 'De otro', testApp.beto.user.id);
    forceDone(testApp, other);
    const queued = createJob(testApp, 'En cola', testApp.ana.user.id);
    const failed = createJob(testApp, 'Falló', testApp.ana.user.id);
    testApp.repo.markRunning(failed, now());
    testApp.repo.finish(failed, { status: 'failed', finishedAt: now(), error: 'x' });

    const status = async (id: string) => {
      const response = await testApp.app.inject({
        method: 'DELETE',
        url: `/api/jobs/${id}/file`,
        headers: testApp.ana.headers,
      });
      return [response.statusCode, apiErrorSchema.parse(response.json()).error.code];
    };
    expect(await status(other)).toEqual([403, 'NOT_OWNER']);
    expect(await status(queued)).toEqual([409, 'JOB_ACTIVE']);
    expect(await status(failed)).toEqual([409, 'NO_FILE']);
    expect(testApp.repo.get(other)?.status).toBe('done');
  });
});

describe('POST /api/history/delete', () => {
  it('borra varios a la vez y devuelve los que no se pudieron, con el motivo', async () => {
    const testApp = await app();
    const a = createJob(testApp, 'A', testApp.ana.user.id);
    const b = createJob(testApp, 'B', testApp.ana.user.id);
    const other = createJob(testApp, 'De otro', testApp.beto.user.id);
    for (const id of [a, b, other]) forceDone(testApp, id);

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/history/delete',
      headers: testApp.ana.headers,
      payload: { ids: [a, b, other], what: 'file' },
    });
    expect(response.statusCode).toBe(200);
    const result = historyBulkDeleteResponseSchema.parse(response.json());
    expect(result.done).toEqual([a, b]);
    expect(result.failed).toEqual([{ id: other, message: expect.any(String) as string }]);
    expect(testApp.repo.get(a)?.status).toBe('expired');
    expect(testApp.repo.get(other)?.status).toBe('done');

    const rows = await testApp.app.inject({
      method: 'POST',
      url: '/api/history/delete',
      headers: testApp.ana.headers,
      payload: { ids: [a, b], what: 'job' },
    });
    expect(historyBulkDeleteResponseSchema.parse(rows.json()).done).toEqual([a, b]);
    expect(testApp.repo.get(a)).toMatchObject({ trashKind: 'job' });
    expect(testApp.repo.get(b)).toMatchObject({ trashKind: 'job' });
  });

  it('400 sin ids o con un modo que no existe', async () => {
    const testApp = await app();
    for (const payload of [
      { ids: [], what: 'file' },
      { ids: ['00000000-0000-4000-8000-999999999999'], what: 'todo' },
    ]) {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/history/delete',
        headers: testApp.ana.headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('papelera (D-115)', () => {
  const del = (testApp: Awaited<ReturnType<typeof app>>, url: string) =>
    testApp.app.inject({ method: 'DELETE', url, headers: testApp.ana.headers });
  const post = (testApp: Awaited<ReturnType<typeof app>>, url: string, payload?: object) =>
    testApp.app.inject({
      method: 'POST',
      url,
      headers: testApp.ana.headers,
      ...(payload ? { payload } : {}),
    });
  const trash = async (testApp: Awaited<ReturnType<typeof app>>, headers = testApp.ana.headers) =>
    trashResponseSchema.parse(
      (await testApp.app.inject({ method: 'GET', url: '/api/trash', headers })).json(),
    );

  it('lista lo propio con qué se borró, cuándo se borra solo y cuánto ocupa', async () => {
    const testApp = await app();
    const fileOnly = createJob(testApp, 'Solo archivo', testApp.ana.user.id);
    const whole = createJob(testApp, 'Entero', testApp.ana.user.id);
    for (const id of [fileOnly, whole]) forceDone(testApp, id);
    testApp.db.prepare('UPDATE jobs SET size_bytes = 1000').run();
    await del(testApp, `/api/jobs/${fileOnly}/file`);
    await del(testApp, `/api/jobs/${whole}`);

    const result = await trash(testApp);
    expect(result.trashDays).toBe(7);
    expect(result.totalBytes).toBe(2000);
    expect(result.items.map((i) => [i.id, i.trashKind])).toEqual(
      expect.arrayContaining([
        [fileOnly, 'file'],
        [whole, 'job'],
      ]),
    );
    const item = result.items.find((i) => i.id === whole);
    expect(item?.trashedAt).toBe(testApp.clock.now.toISOString());
    expect(item?.purgeAt).toBe('2026-11-05T12:00:00.000Z');
    // Nadie más la ve.
    expect((await trash(testApp, testApp.beto.headers)).items).toEqual([]);
  });

  it('restaurar devuelve el archivo y la fila; la retención vuelve a contar desde ahí', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Volvé', testApp.ana.user.id);
    forceDone(testApp, jobId);
    // Terminado hace mucho: sin restored_at la retención lo vencería en la próxima pasada.
    testApp.db
      .prepare("UPDATE jobs SET finished_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .run(jobId);
    await del(testApp, `/api/jobs/${jobId}`);

    const response = await post(testApp, '/api/trash/restore', { ids: [jobId] });
    expect(historyBulkDeleteResponseSchema.parse(response.json()).done).toEqual([jobId]);
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(testApp.filesDir, `${jobId}.mp4`))).toBe(true);
    expect(existsSync(path.join(testApp.trashDir, `${jobId}.mp4`))).toBe(false);
    expect(testApp.repo.get(jobId)).toMatchObject({
      status: 'done',
      trashKind: null,
      trashPath: null,
      restoredAt: testApp.clock.now.toISOString(),
    });
    expect(testApp.repo.listExpirable('2026-10-01T00:00:00.000Z')).toEqual([]);
    expect(testApp.repo.listExpirable('2026-11-01T00:00:00.000Z').map((j) => j.id)).toEqual([
      jobId,
    ]);
    expect(
      testApp.events.some(
        (e) => e.type === 'job.updated' && e.job.id === jobId && e.job.status === 'done',
      ),
    ).toBe(true);
    // Vuelve a verse en el historial, con su archivo.
    const own = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/history',
          headers: testApp.ana.headers,
        })
      ).json(),
    );
    expect(own.items.map((i) => [i.id, i.status, i.inTrash])).toEqual([[jobId, 'done', undefined]]);
  });

  it('borrar para siempre y vaciar: el archivo se va y la fila «entera» también', async () => {
    const testApp = await app();
    const fileOnly = createJob(testApp, 'Solo archivo', testApp.ana.user.id);
    const whole = createJob(testApp, 'Entero', testApp.ana.user.id);
    const other = createJob(testApp, 'De otro', testApp.ana.user.id);
    for (const id of [fileOnly, whole, other]) forceDone(testApp, id);
    testApp.db.prepare('UPDATE jobs SET size_bytes = 1000').run();
    await del(testApp, `/api/jobs/${fileOnly}/file`);
    await del(testApp, `/api/jobs/${whole}`);
    await del(testApp, `/api/jobs/${other}`);

    const purge = await post(testApp, '/api/trash/purge', { ids: [fileOnly] });
    expect(historyBulkDeleteResponseSchema.parse(purge.json()).done).toEqual([fileOnly]);
    // Solo el archivo: la fila queda en el historial como expirada, sin papelera.
    expect(testApp.repo.get(fileOnly)).toMatchObject({ status: 'expired', trashKind: null });
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(testApp.trashDir, `${fileOnly}.mp4`))).toBe(false);

    const empty = await post(testApp, '/api/trash/empty');
    expect(trashEmptyResponseSchema.parse(empty.json())).toEqual({ purged: 2, freedBytes: 2000 });
    expect(testApp.repo.get(whole)).toBeNull();
    expect(testApp.repo.get(other)).toBeNull();
    expect((await trash(testApp)).items).toEqual([]);
  });

  it('lo ajeno o lo que no está en la papelera no se toca', async () => {
    const testApp = await app();
    const betos = createJob(testApp, 'De Beto', testApp.beto.user.id);
    forceDone(testApp, betos);
    await testApp.app.inject({
      method: 'DELETE',
      url: `/api/jobs/${betos}`,
      headers: testApp.beto.headers,
    });
    const mine = createJob(testApp, 'Mío', testApp.ana.user.id);
    forceDone(testApp, mine);

    for (const url of ['/api/trash/restore', '/api/trash/purge']) {
      const result = historyBulkDeleteResponseSchema.parse(
        (await post(testApp, url, { ids: [betos, mine] })).json(),
      );
      expect(result.done).toEqual([]);
      expect(result.failed.map((f) => f.id)).toEqual([betos, mine]);
    }
    expect(testApp.repo.get(betos)).toMatchObject({ trashKind: 'job' });
    expect(testApp.repo.get(mine)).toMatchObject({ status: 'done', trashKind: null });
  });

  it('a los 7 días se borra para siempre solo', async () => {
    const testApp = await app();
    const old = createJob(testApp, 'Viejo', testApp.ana.user.id);
    const recent = createJob(testApp, 'Reciente', testApp.ana.user.id);
    for (const id of [old, recent]) forceDone(testApp, id);
    await del(testApp, `/api/jobs/${old}`);
    testApp.clock.now = new Date('2026-11-04T12:00:00.000Z');
    await del(testApp, `/api/jobs/${recent}/file`);

    testApp.clock.now = new Date('2026-11-05T12:00:01.000Z');
    expect(await testApp.history.purgeExpiredTrash()).toBe(1);
    expect(testApp.repo.get(old)).toBeNull();
    expect(testApp.repo.get(recent)).toMatchObject({ trashKind: 'file' });
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(testApp.trashDir, `${old}.mp4`))).toBe(false);
    expect(existsSync(path.join(testApp.trashDir, `${recent}.mp4`))).toBe(true);
  });
});

describe('PATCH /api/jobs/:id', () => {
  it('cambia el título de un trabajo propio, se busca por el nuevo y se publica', async () => {
    const testApp = await app();
    const jobId = createJob(testApp, 'Viejo', testApp.ana.user.id);
    forceDone(testApp, jobId);
    const response = await testApp.app.inject({
      method: 'PATCH',
      url: `/api/jobs/${jobId}`,
      headers: testApp.ana.headers,
      payload: { title: '  Reunión de equipo  ' },
    });
    expect(response.statusCode).toBe(200);
    expect(jobResponseSchema.parse(response.json()).job.title).toBe('Reunión de equipo');
    expect(
      testApp.events.some(
        (e) =>
          e.type === 'job.updated' && e.job.id === jobId && e.job.title === 'Reunión de equipo',
      ),
    ).toBe(true);

    const found = historyResponseSchema.parse(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/history?q=reunion',
          headers: testApp.ana.headers,
        })
      ).json(),
    );
    expect(found.items.map((i) => i.id)).toEqual([jobId]);
  });

  it('400 vacío; 403 de otra persona; 409 en curso', async () => {
    const testApp = await app();
    const mine = createJob(testApp, 'Mío', testApp.ana.user.id);
    forceDone(testApp, mine);
    const other = createJob(testApp, 'De otro', testApp.beto.user.id);
    forceDone(testApp, other);
    const queued = createJob(testApp, 'En cola', testApp.ana.user.id);

    const patch = async (id: string, title: string) =>
      (
        await testApp.app.inject({
          method: 'PATCH',
          url: `/api/jobs/${id}`,
          headers: testApp.ana.headers,
          payload: { title },
        })
      ).statusCode;
    expect(await patch(mine, '   ')).toBe(400);
    expect(await patch(other, 'Nuevo')).toBe(403);
    expect(await patch(queued, 'Nuevo')).toBe(409);
    expect(testApp.repo.get(other)?.title).toBe('De otro');
    expect(testApp.repo.get(queued)?.title).toBe('En cola');
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
      compression: 0,
      recording: 1,
    });
  });

  it('una cuenta sin trabajos ve todo en cero', async () => {
    const testApp = await app();
    const response = await testApp.app.inject({ method: 'GET', url: '/api/active-jobs' });
    expect(response.json()).toEqual({ download: 0, conversion: 0, compression: 0, recording: 0 });
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

    // El usuario es la cuenta (D-104), no la PC.
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
