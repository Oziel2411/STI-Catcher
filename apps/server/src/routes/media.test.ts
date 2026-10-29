import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { apiErrorSchema, createJobResponseSchema, probeResponseSchema } from '@sti-catcher/shared';
import type { ProbeResponse } from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { UrlBlockedError } from '../adapters/url-guard.ts';
import { YtdlpError } from '../adapters/ytdlp.ts';
import { flush, makeTestApp } from '../../test/test-app.ts';

const sampleProbe: ProbeResponse = {
  url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  title: 'Big Buck Bunny',
  site: 'Youtube',
  uploader: 'Blender',
  thumbnailUrl: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg',
  durationSeconds: 635,
  isLive: false,
  hasVideo: true,
  hasAudio: true,
  resolutions: [
    { height: 2160, codecs: ['vp9', 'av1'] },
    { height: 1080, codecs: ['h264', 'vp9', 'av1'] },
  ],
  maxH264Height: 1080,
};

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app(options: Parameters<typeof makeTestApp>[0] = {}) {
  const testApp = await makeTestApp(options);
  storageDirs.push(testApp.storageDir);
  return testApp;
}

describe('POST /api/media/probe', () => {
  it('devuelve el análisis', async () => {
    const { app: server, probe } = await app({ probe: () => Promise.resolve(sampleProbe) });
    const response = await server.inject({
      method: 'POST',
      url: '/api/media/probe',
      payload: { url: 'https://youtu.be/aqz-KE-bpKQ' },
    });
    expect(response.statusCode).toBe(200);
    expect(probeResponseSchema.parse(response.json())).toEqual(sampleProbe);
    expect(probe).toHaveBeenCalledWith('https://youtu.be/aqz-KE-bpKQ');
  });

  it('400 para una URL que no es http/https, sin llamar a yt-dlp', async () => {
    const { app: server, probe } = await app();
    const response = await server.inject({
      method: 'POST',
      url: '/api/media/probe',
      payload: { url: 'file:///C:/Windows/win.ini' },
    });
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.issues?.[0]?.message).toMatch(/http/);
    expect(probe).not.toHaveBeenCalled();
  });

  it('400 si la URL apunta a la red interna', async () => {
    const { app: server } = await app({ checkUrl: () => Promise.reject(new UrlBlockedError()) });
    const response = await server.inject({
      method: 'POST',
      url: '/api/media/probe',
      payload: { url: 'http://192.168.0.1/' },
    });
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('URL_BLOCKED');
  });

  it('422 con el mensaje traducido si yt-dlp falla (p. ej. video privado)', async () => {
    const { app: server } = await app({
      probe: () =>
        Promise.reject(
          new YtdlpError({ code: 'PRIVATE', message: 'El video es privado.' }, ['ERROR: x']),
        ),
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/media/probe',
      payload: { url: 'https://youtu.be/privado' },
    });
    expect(response.statusCode).toBe(422);
    expect(apiErrorSchema.parse(response.json()).error).toEqual({
      code: 'PRIVATE',
      message: 'El video es privado.',
    });
  });

  it('429 si hay demasiados análisis simultáneos', async () => {
    // Análisis que no terminan hasta que el test lo indica.
    const pending: (() => void)[] = [];
    const { app: server } = await app({
      probe: () =>
        new Promise((resolve) => {
          pending.push(() => {
            resolve(sampleProbe);
          });
        }),
    });
    const send = () =>
      server.inject({
        method: 'POST',
        url: '/api/media/probe',
        payload: { url: 'https://youtu.be/x' },
      });
    const first = Array.from({ length: 4 }, send);
    await flush();
    const fifth = await send();
    expect(fifth.statusCode).toBe(429);
    for (const release of pending) release();
    expect((await Promise.all(first)).every((r) => r.statusCode === 200)).toBe(true);
  });
});

describe('POST /api/jobs/download', () => {
  it('202 con el jobId; el job guarda URL, opciones y el título del análisis', async () => {
    const { app: server, runs } = await app();
    const response = await server.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: {
        url: 'https://youtu.be/aqz-KE-bpKQ',
        maxHeight: 1080,
        title: 'Big Buck Bunny',
      },
    });
    expect(response.statusCode).toBe(202);
    const { jobId } = createJobResponseSchema.parse(response.json());
    await flush();
    expect(runs[0]?.context.job).toMatchObject({
      id: jobId,
      type: 'download',
      title: 'Big Buck Bunny',
      sourceUrl: 'https://youtu.be/aqz-KE-bpKQ',
      params: {
        url: 'https://youtu.be/aqz-KE-bpKQ',
        format: 'mp4',
        maxHeight: 1080,
        videoMode: 'compat',
      },
    });
  });

  it('para audio ignora la altura', async () => {
    const { app: server, runs } = await app();
    await server.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'https://youtu.be/x', format: 'mp3', maxHeight: 1080 },
    });
    await flush();
    expect(runs[0]?.context.job.params).toMatchObject({ format: 'mp3', maxHeight: null });
  });

  it('400 si la URL apunta a la red interna; no crea el job', async () => {
    const { app: server, queue } = await app({
      checkUrl: () => Promise.reject(new UrlBlockedError()),
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'http://10.0.0.1/' },
    });
    expect(response.statusCode).toBe(400);
    expect(queue.list({ limit: 10 })).toHaveLength(0);
  });

  it('507 sin espacio en disco', async () => {
    const { app: server } = await app({ freeDiskBytes: 1 });
    const response = await server.inject({
      method: 'POST',
      url: '/api/jobs/download',
      payload: { url: 'https://youtu.be/x' },
    });
    expect(response.statusCode).toBe(507);
  });
});

describe('GET /api/jobs/:id/file', () => {
  /** Crea un job terminado con su archivo, como lo dejaría la cola. */
  async function finishedJob(title: string) {
    const testApp = await app();
    const job = await testApp.queue.enqueue({ type: 'download', params: {}, title });
    await flush();
    mkdirSync(testApp.filesDir, { recursive: true });
    writeFileSync(path.join(testApp.filesDir, `${job.id}.mp4`), Buffer.alloc(1000, 7));
    testApp.repo.finish(job.id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      filePath: `files/${job.id}.mp4`,
      title,
    });
    return { ...testApp, jobId: job.id };
  }

  it('sirve el archivo con el título como nombre, codificado RFC 5987', async () => {
    const { app: server, jobId } = await finishedJob('Canción del ñandú: "en vivo" 🎵');
    const response = await server.inject({ method: 'GET', url: `/api/jobs/${jobId}/file` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.rawPayload.length).toBe(1000);
    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toContain('attachment');
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent('Canción del ñandú en vivo 🎵.mp4')}`,
    );
  });

  it('soporta Range (para adelantar el video)', async () => {
    const { app: server, jobId } = await finishedJob('x');
    const response = await server.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}/file`,
      headers: { range: 'bytes=100-199' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 100-199/1000');
    expect(response.rawPayload.length).toBe(100);
  });

  it('410 si el archivo ya no está en disco', async () => {
    const { app: server, jobId, filesDir } = await finishedJob('x');
    rmSync(path.join(filesDir, `${jobId}.mp4`));
    const response = await server.inject({ method: 'GET', url: `/api/jobs/${jobId}/file` });
    expect(response.statusCode).toBe(410);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('FILE_GONE');
  });

  it('409 si el job todavía no terminó; 404 si no existe; 400 si el id no es válido', async () => {
    const { app: server, queue } = await app();
    const job = await queue.enqueue({ type: 'download', params: {} });
    expect(
      (await server.inject({ method: 'GET', url: `/api/jobs/${job.id}/file` })).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/jobs/00000000-0000-4000-8000-999999999999/file',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await server.inject({ method: 'GET', url: '/api/jobs/..%2F..%2Fwin.ini/file' })).statusCode,
    ).toBe(400);
  });
});
