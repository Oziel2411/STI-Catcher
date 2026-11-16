import { rmSync } from 'node:fs';
import {
  apiErrorSchema,
  compressionSourceResponseSchema,
  createJobResponseSchema,
  uploadResponseSchema,
} from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaInfo } from '../adapters/ffprobe.ts';
import { makeTestApp, sampleVideoMedia } from '../../test/test-app.ts';

const audioOnly: MediaInfo = { ...sampleVideoMedia, video: null };

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app(options: Parameters<typeof makeTestApp>[0] = {}) {
  const testApp = await makeTestApp(options);
  storageDirs.push(testApp.storageDir);
  return testApp;
}
type TestApp = Awaited<ReturnType<typeof app>>;

async function uploadedJobId(testApp: TestApp, name = 'Reunión.MOV') {
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
    },
    payload: Buffer.alloc(500, 7),
  });
  expect(response.statusCode).toBe(201);
  return uploadResponseSchema.parse(response.json()).jobId;
}

const compress = (testApp: TestApp, payload: object) =>
  testApp.app.inject({ method: 'POST', url: '/api/jobs/compress', payload });

describe('GET /api/compression/sources/:id', () => {
  it('devuelve lo que hace falta para estimar y con qué codifica el server', async () => {
    const testApp = await app({ encoders: { h264: 'qsv', hevc: 'cpu' } });
    const jobId = await uploadedJobId(testApp);
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/compression/sources/${jobId}`,
    });
    expect(response.statusCode).toBe(200);
    const source = compressionSourceResponseSchema.parse(response.json());
    expect(source.media).toMatchObject({
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      frameRate: 30,
      durationSeconds: 12,
      sizeBytes: 1000,
    });
    expect(source.encoders).toEqual({ h264: 'qsv', hevc: 'cpu' });
  });

  it('422 si el archivo no tiene video; 404 si no existe', async () => {
    const testApp = await app({ ffprobe: () => Promise.resolve(audioOnly) });
    const jobId = await uploadedJobId(testApp, 'nota.m4a');
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/compression/sources/${jobId}`,
    });
    expect(response.statusCode).toBe(422);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NO_VIDEO');
    expect(
      (
        await testApp.app.inject({
          method: 'GET',
          url: '/api/compression/sources/00000000-0000-4000-8000-0000000000ff',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('POST /api/jobs/compress', () => {
  it('crea la compresión vinculada al original, a nombre de quien la pide', async () => {
    const testApp = await app();
    const sourceJobId = await uploadedJobId(testApp, 'Reunión.MOV');
    const response = await compress(testApp, {
      sourceJobId,
      preset: 'share-720p',
      audioKbps: 64,
      notify: [testApp.ana.user.id],
    });
    expect(response.statusCode).toBe(202);
    const { jobId } = createJobResponseSchema.parse(response.json());
    expect(testApp.repo.get(jobId)).toMatchObject({
      type: 'compression',
      parentJobId: sourceJobId,
      title: 'Reunión.MOV (comprimido)',
      params: {
        sourceJobId,
        options: {
          preset: 'share-720p',
          target: { mode: 'quality' },
          maxHeight: null,
          audioKbps: 64,
        },
      },
      userId: testApp.ana.user.id,
      notifyUserIds: [testApp.ana.user.id],
    });
  });

  it('tamaño objetivo al que no se llega: 422 con la sugerencia, sin crear nada', async () => {
    const long: MediaInfo = {
      ...sampleVideoMedia,
      durationSeconds: 2 * 3600,
      sizeBytes: 3 * 1024 ** 3,
    };
    const testApp = await app({ ffprobe: () => Promise.resolve(long) });
    const sourceJobId = await uploadedJobId(testApp);
    const response = await compress(testApp, {
      sourceJobId,
      preset: 'share-720p',
      target: { mode: 'size', megabytes: 24 },
    });
    expect(response.statusCode).toBe(422);
    expect(apiErrorSchema.parse(response.json()).error).toMatchObject({
      code: 'TARGET_NOT_REACHABLE',
      message: expect.stringMatching(/Es demasiado largo para que entre en 24 MB/) as unknown,
    });
    expect(testApp.repo.list({ types: ['compression'], limit: 10 })).toEqual([]);
  });

  it('400 con opciones fuera de la lista (nunca argumentos libres)', async () => {
    const testApp = await app();
    const sourceJobId = await uploadedJobId(testApp);
    for (const payload of [
      { sourceJobId, preset: 'ultra' },
      { sourceJobId, preset: 'share-720p', audioKbps: 320 },
      { sourceJobId, preset: 'share-720p', target: { mode: 'size', megabytes: 1 } },
    ]) {
      expect((await compress(testApp, payload)).statusCode).toBe(400);
    }
  });
});
