import { rmSync } from 'node:fs';
import {
  apiErrorSchema,
  editResponseSchema,
  editSourceResponseSchema,
  uploadResponseSchema,
} from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test/test-app.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app() {
  const testApp = await makeTestApp();
  storageDirs.push(testApp.storageDir);
  return testApp;
}
type TestApp = Awaited<ReturnType<typeof app>>;

async function uploadedJobId(testApp: TestApp) {
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'clase.mp4' },
    payload: Buffer.alloc(500, 7),
  });
  expect(response.statusCode).toBe(201);
  return uploadResponseSchema.parse(response.json()).jobId;
}

const edit = (testApp: TestApp, payload: object) =>
  testApp.app.inject({ method: 'POST', url: '/api/jobs/edit', payload });

describe('recortar y dividir (D-114)', () => {
  it('GET /api/edit/sources/:id: duración y cuadros por segundo del original', async () => {
    const testApp = await app();
    const jobId = await uploadedJobId(testApp);
    const response = await testApp.app.inject({ method: 'GET', url: `/api/edit/sources/${jobId}` });
    expect(response.statusCode).toBe(200);
    const source = editSourceResponseSchema.parse(response.json());
    expect(source.media).toMatchObject({ durationSeconds: 12, frameRate: 30 });
  });

  it('POST /api/jobs/edit dividido: 202 con un trabajo por tramo, en cola', async () => {
    const testApp = await app();
    const jobId = await uploadedJobId(testApp);
    const response = await edit(testApp, {
      sourceJobId: jobId,
      segments: [
        { start: 0, end: 4 },
        { start: 6, end: 12 },
      ],
      output: 'split',
    });
    expect(response.statusCode).toBe(202);
    const { jobIds } = editResponseSchema.parse(response.json());
    expect(jobIds).toHaveLength(2);
    const second = testApp.repo.get(jobIds[1] ?? '');
    expect(second).toMatchObject({
      type: 'edit',
      parentJobId: jobId,
      title: 'clase.mp4 (parte 2 de 2)',
    });
  });

  it('un tramo más allá del final del video: 422 con el motivo', async () => {
    const testApp = await app();
    const jobId = await uploadedJobId(testApp);
    const response = await edit(testApp, {
      sourceJobId: jobId,
      segments: [{ start: 20, end: 30 }],
    });
    expect(response.statusCode).toBe(422);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('SEGMENT_OUT_OF_RANGE');
  });

  it('tramos que se pisan: 400', async () => {
    const testApp = await app();
    const jobId = await uploadedJobId(testApp);
    const response = await edit(testApp, {
      sourceJobId: jobId,
      segments: [
        { start: 0, end: 5 },
        { start: 4, end: 8 },
      ],
    });
    expect(response.statusCode).toBe(400);
  });
});
