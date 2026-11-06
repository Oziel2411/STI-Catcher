import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  apiErrorSchema,
  conversionOptionsResponseSchema,
  conversionSourceResponseSchema,
  createJobResponseSchema,
  historyResponseSchema,
  uploadResponseSchema,
} from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaInfo } from '../adapters/ffprobe.ts';
import { flush, makeTestApp, sampleVideoMedia } from '../../test/test-app.ts';
import { fileOps } from '../adapters/files.ts';
import {
  createUploadService,
  describeUploadName,
  UploadError,
} from '../modules/conversion/upload-service.ts';

// La sesión por defecto de la app de prueba («ana») va sola en cada pedido.
const headers = {};
const audioOnly: MediaInfo = {
  ...sampleVideoMedia,
  video: null,
  audio: { codec: 'aac', channels: 1 },
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

type TestApp = Awaited<ReturnType<typeof app>>;

/** Sube un archivo como lo hace el navegador (cuerpo binario + nombre en un header). */
async function upload(testApp: TestApp, name = 'Video del acto.MOV', body = Buffer.alloc(500, 7)) {
  return testApp.app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
    },
    payload: body,
  });
}

async function uploadedJobId(testApp: TestApp, name?: string) {
  const response = await upload(testApp, name);
  expect(response.statusCode).toBe(201);
  return uploadResponseSchema.parse(response.json()).jobId;
}

describe('GET /api/conversion/options', () => {
  it('informa los límites del GIF y de la subida', async () => {
    const testApp = await app({ maxUploadBytes: 2048 * 1024 ** 2 });
    const response = await testApp.app.inject({ method: 'GET', url: '/api/conversion/options' });
    expect(conversionOptionsResponseSchema.parse(response.json())).toEqual({
      gif: { maxSeconds: 30, maxFps: 15, maxWidth: 800, defaultFps: 10, defaultWidth: 480 },
      maxUploadBytes: 2048 * 1024 ** 2,
    });
  });
});

describe('POST /api/uploads', () => {
  it('escribe el archivo en disco y lo registra como subida terminada, propia', async () => {
    const testApp = await app();
    const jobId = await uploadedJobId(testApp, 'Video del acto.MOV');
    const job = testApp.repo.get(jobId);
    expect(job).toMatchObject({
      type: 'upload',
      status: 'done',
      title: 'Video del acto.MOV',
      filePath: `files/${jobId}.mov`,
      format: 'mov',
      resolution: '1920x1080',
      videoCodec: 'hevc',
      userId: testApp.ana.user.id,
    });
    expect(readFileSync(path.join(testApp.filesDir, `${jobId}.mov`))).toEqual(Buffer.alloc(500, 7));
    expect(readdirSync(path.join(testApp.storageDir, 'tmp'))).toEqual([]);
  });

  it('413 si el tamaño declarado supera el máximo, sin escribir nada', async () => {
    const testApp = await app({ maxUploadBytes: 100 });
    const response = await upload(testApp, 'grande.mp4', Buffer.alloc(200));
    expect(response.statusCode).toBe(413);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('TOO_LARGE');
    expect(readdirSync(testApp.filesDir)).toEqual([]);
  });

  it('422 y se borra si no es video ni audio', async () => {
    const testApp = await app({
      ffprobe: () => Promise.resolve({ ...sampleVideoMedia, video: null, audio: null }),
    });
    const response = await upload(testApp, 'planilla.xlsx');
    expect(response.statusCode).toBe(422);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_MEDIA');
    expect(readdirSync(path.join(testApp.storageDir, 'tmp'))).toEqual([]);
    expect(readdirSync(testApp.filesDir)).toEqual([]);
  });

  it('415 si no se manda como application/octet-stream', async () => {
    const testApp = await app();
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { 'content-type': 'application/json' },
      payload: { a: 1 },
    });
    expect(response.statusCode).toBe(415);
  });

  it('507 sin espacio en disco', async () => {
    const testApp = await app({ freeDiskBytes: 10 });
    expect((await upload(testApp)).statusCode).toBe(507);
  });
});

describe('createUploadService (streaming sin Content-Length)', () => {
  it('corta al superar el máximo aunque el tamaño no se haya declarado, y no deja parciales', async () => {
    const testApp = await app();
    const tempDir = path.join(testApp.storageDir, 'tmp');
    const service = createUploadService({
      tempDir,
      filesDir: testApp.filesDir,
      maxUploadBytes: 1000,
      minFreeDiskBytes: 0,
      readFreeDiskBytes: () => Promise.resolve(1024 ** 4),
      ffprobe: () => Promise.resolve(sampleVideoMedia),
      files: fileOps,
      queue: testApp.queue,
    });
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(300));
    const error = await service({
      stream: Readable.from(chunks),
      declaredBytes: null,
      fileName: 'x.mp4',
      requester: { userId: null, ip: null },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).status).toBe(413);
    expect(readdirSync(tempDir)).toEqual([]);
  });
});

describe('describeUploadName', () => {
  it('usa solo el nombre (sin carpetas) como título y una extensión segura', () => {
    expect(describeUploadName('C:\\fakepath\\Video final.MOV')).toEqual({
      title: 'Video final.MOV',
      extension: '.mov',
    });
    expect(describeUploadName('../../etc/passwd')).toEqual({ title: 'passwd', extension: '.bin' });
    expect(describeUploadName('raro.ext-larguísima')).toEqual({
      title: 'raro.ext-larguísima',
      extension: '.bin',
    });
    expect(describeUploadName('')).toEqual({ title: 'Archivo subido', extension: '.bin' });
  });
});

describe('GET /api/conversion/sources/:id', () => {
  it('un .mov (video + audio) ofrece MP4, MP3 y GIF, entre otros', async () => {
    const testApp = await app();
    const jobId = await uploadedJobId(testApp);
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/conversion/sources/${jobId}`,
    });
    const source = conversionSourceResponseSchema.parse(response.json());
    expect(source.presets).toEqual(expect.arrayContaining(['mp4', 'mp3', 'gif']));
    expect(source.media).toMatchObject({ hasVideo: true, hasAudio: true, height: 1080 });
  });

  it('un archivo de solo audio no ofrece salidas de video', async () => {
    const testApp = await app({ ffprobe: () => Promise.resolve(audioOnly) });
    const jobId = await uploadedJobId(testApp, 'nota de voz.m4a');
    const source = conversionSourceResponseSchema.parse(
      (await testApp.app.inject({ method: 'GET', url: `/api/conversion/sources/${jobId}` })).json(),
    );
    expect(source.presets).toEqual(['mp3', 'm4a', 'wav']);
  });

  it('410 si el archivo expiró; 409 si el trabajo no terminó', async () => {
    const testApp = await app();
    const jobId = await uploadedJobId(testApp);
    rmSync(path.join(testApp.filesDir, `${jobId}.mov`));
    testApp.queue.expire(jobId);
    expect(
      (await testApp.app.inject({ method: 'GET', url: `/api/conversion/sources/${jobId}` }))
        .statusCode,
    ).toBe(410);

    const pending = await testApp.queue.enqueue({ type: 'download', params: {} });
    expect(
      (await testApp.app.inject({ method: 'GET', url: `/api/conversion/sources/${pending.id}` }))
        .statusCode,
    ).toBe(409);
  });
});

describe('POST /api/jobs/convert', () => {
  const convert = (testApp: TestApp, payload: object) =>
    testApp.app.inject({ method: 'POST', url: '/api/jobs/convert', headers, payload });

  it('crea la conversión vinculada al original, a nombre de quien la pide', async () => {
    const testApp = await app();
    const sourceJobId = await uploadedJobId(testApp, 'Video del acto.MOV');
    const response = await convert(testApp, { sourceJobId, preset: 'mp4', maxHeight: 720 });
    expect(response.statusCode).toBe(202);
    const { jobId } = createJobResponseSchema.parse(response.json());
    expect(testApp.repo.get(jobId)).toMatchObject({
      type: 'conversion',
      parentJobId: sourceJobId,
      title: 'Video del acto.MOV → MP4',
      params: { sourceJobId, preset: 'mp4', maxHeight: 720 },
      userId: testApp.ana.user.id,
    });

    // En el historial se ve de qué archivo salió.
    await flush();
    const history = historyResponseSchema.parse(
      (await testApp.app.inject({ method: 'GET', url: '/api/history', headers })).json(),
    );
    expect(history.items.find((i) => i.id === jobId)?.parentTitle).toBe('Video del acto.MOV');
  });

  it('escalar a una altura igual o mayor que el original se ignora', async () => {
    const testApp = await app();
    const sourceJobId = await uploadedJobId(testApp);
    const { jobId } = createJobResponseSchema.parse(
      (await convert(testApp, { sourceJobId, preset: 'mp4', maxHeight: 2160 })).json(),
    );
    expect(testApp.repo.get(jobId)?.params).toMatchObject({ maxHeight: null });
  });

  it('422 si el preset no tiene sentido para el archivo (video desde un audio)', async () => {
    const testApp = await app({ ffprobe: () => Promise.resolve(audioOnly) });
    const sourceJobId = await uploadedJobId(testApp, 'nota.m4a');
    const response = await convert(testApp, { sourceJobId, preset: 'gif' });
    expect(response.statusCode).toBe(422);
    expect(apiErrorSchema.parse(response.json()).error).toMatchObject({
      code: 'PRESET_NOT_AVAILABLE',
      message: expect.stringContaining('no tiene video') as string,
    });
  });

  it('GIF: exige opciones y respeta los topes', async () => {
    const testApp = await app();
    const sourceJobId = await uploadedJobId(testApp);
    expect((await convert(testApp, { sourceJobId, preset: 'gif' })).statusCode).toBe(422);

    const tooLong = await convert(testApp, {
      sourceJobId,
      preset: 'gif',
      gif: { startSeconds: 0, endSeconds: 12, fps: 30, width: 2000 },
    });
    expect(tooLong.statusCode).toBe(422);
    const message = apiErrorSchema.parse(tooLong.json()).error.message;
    expect(message).toContain('cuadros por segundo es 15');
    expect(message).toContain('ancho máximo es 800');

    const afterEnd = await convert(testApp, {
      sourceJobId,
      preset: 'gif',
      gif: { startSeconds: 5, endSeconds: 20, fps: 10, width: 480 },
    });
    expect(apiErrorSchema.parse(afterEnd.json()).error.message).toContain('posterior al final');

    const ok = await convert(testApp, {
      sourceJobId,
      preset: 'gif',
      gif: { startSeconds: 2, endSeconds: 7, fps: 10, width: 480 },
    });
    expect(ok.statusCode).toBe(202);
  });

  it('una conversión fallida se puede reintentar', async () => {
    const testApp = await app();
    const sourceJobId = await uploadedJobId(testApp);
    const { jobId } = createJobResponseSchema.parse(
      (await convert(testApp, { sourceJobId, preset: 'mp3' })).json(),
    );
    testApp.queue.cancel(jobId);
    await flush();
    const retry = await testApp.app.inject({
      method: 'POST',
      url: `/api/jobs/${jobId}/retry`,
      headers,
    });
    expect(retry.statusCode).toBe(202);
    const { jobId: newId } = createJobResponseSchema.parse(retry.json());
    expect(testApp.repo.get(newId)).toMatchObject({ type: 'conversion', parentJobId: sourceJobId });
    expect(existsSync(path.join(testApp.filesDir, `${sourceJobId}.mov`))).toBe(true);
  });
});
