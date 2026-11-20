import type { Job } from '@sti-catcher/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Ffprobe, MediaInfo } from '../../adapters/ffprobe.ts';
import type { EnqueueInput } from '../../jobs/queue.ts';
import type { JobRecord } from '../../jobs/types.ts';
import { createEditService, EditError, editTitle, fitSegments } from './edit-service.ts';

const SOURCE_ID = '00000000-0000-4000-8000-00000000000a';
const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const BATCH = '00000000-0000-4000-8000-0000000000cc';

const video: MediaInfo = {
  durationSeconds: 60,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  sizeBytes: 1000,
  video: { codec: 'h264', width: 1920, height: 1080, pixFmt: 'yuv420p', frameRate: 30 },
  audio: { codec: 'aac', channels: 2 },
};

function setup({
  source = {
    id: SOURCE_ID,
    type: 'recording',
    status: 'done',
    title: 'Reunión',
    filePath: `files/${SOURCE_ID}.mp4`,
  } as JobRecord,
  media = video,
}: { source?: JobRecord; media?: MediaInfo | null } = {}) {
  const enqueued: EnqueueInput[] = [];
  const queue = {
    toApi: vi.fn((record: JobRecord) => ({ id: record.id }) as Job),
    enqueue: vi.fn((input: EnqueueInput) => {
      enqueued.push(input);
      return Promise.resolve({ id: `job-${String(enqueued.length)}` } as Job);
    }),
  };
  const noticeBatches = { create: vi.fn(() => BATCH), close: vi.fn() };
  const service = createEditService({
    getJob: (id) => (id === SOURCE_ID ? source : null),
    storageDir: 'S:\\storage',
    filesDir: 'S:\\storage\\files',
    ffprobe: vi.fn<Ffprobe>(() =>
      media === null ? Promise.reject(new Error('no')) : Promise.resolve(media),
    ),
    queue,
    noticeBatches,
  });
  return { service, enqueued, noticeBatches };
}

const requester = { userId: USER, ip: '192.168.3.10' };
const twoParts = [
  { start: 0, end: 10 },
  { start: 30, end: 40 },
];

describe('fitSegments', () => {
  it('un fin que se pasa por redondeo queda en el final', () => {
    expect(fitSegments([{ start: 50, end: 60.05 }], 60)).toEqual([{ start: 50, end: 60 }]);
  });

  it('un tramo que termina después del final es un error', () => {
    expect(fitSegments([{ start: 50, end: 61 }], 60)).toHaveProperty('error');
  });

  it('sin duración conocida no se toca nada', () => {
    expect(fitSegments([{ start: 50, end: 90 }], null)).toEqual([{ start: 50, end: 90 }]);
  });
});

describe('editTitle', () => {
  it('recortado o la parte', () => {
    expect(editTitle('Reunión', null, 1)).toBe('Reunión (recortado)');
    expect(editTitle(null, 2, 3)).toBe('Video (parte 2 de 3)');
  });
});

describe('createEditService', () => {
  it('unir: un solo job con todos los tramos, vinculado al origen', async () => {
    const { service, enqueued, noticeBatches } = setup();
    const jobs = await service.enqueue({ sourceJobId: SOURCE_ID, segments: twoParts }, requester);
    expect(jobs).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      type: 'edit',
      title: 'Reunión (recortado)',
      parentJobId: SOURCE_ID,
      userId: USER,
      params: { sourceJobId: SOURCE_ID, segments: twoParts, precision: 'exact' },
    });
    expect(noticeBatches.create).not.toHaveBeenCalled();
  });

  it('dividir: un job por tramo, en orden y con su número de parte', async () => {
    const { service, enqueued } = setup();
    const jobs = await service.enqueue(
      { sourceJobId: SOURCE_ID, segments: twoParts, output: 'split', precision: 'fast' },
      requester,
    );
    expect(jobs.map((job) => job.id)).toEqual(['job-1', 'job-2']);
    expect(enqueued.map((e) => e.title)).toEqual([
      'Reunión (parte 1 de 2)',
      'Reunión (parte 2 de 2)',
    ]);
    expect(enqueued.map((e) => e.params)).toEqual([
      { sourceJobId: SOURCE_ID, segments: [twoParts[0]], precision: 'fast' },
      { sourceJobId: SOURCE_ID, segments: [twoParts[1]], precision: 'fast' },
    ]);
  });

  it('dividir con aviso y sin pedido: abre uno propio, así llega un solo mail', async () => {
    const { service, enqueued, noticeBatches } = setup();
    await service.enqueue(
      { sourceJobId: SOURCE_ID, segments: twoParts, output: 'split', notify: [USER, OTHER] },
      requester,
    );
    expect(noticeBatches.create).toHaveBeenCalledWith(USER, [USER, OTHER]);
    expect(enqueued.map((e) => e.noticeBatchId)).toEqual([BATCH, BATCH]);
    expect(noticeBatches.close).toHaveBeenCalledWith(BATCH, USER);
  });

  it('con un pedido de la web usa ese y no lo cierra', async () => {
    const { service, enqueued, noticeBatches } = setup();
    const other = '00000000-0000-4000-8000-0000000000dd';
    await service.enqueue(
      {
        sourceJobId: SOURCE_ID,
        segments: twoParts,
        output: 'split',
        notify: [USER],
        batchId: other,
      },
      requester,
    );
    expect(enqueued.map((e) => e.noticeBatchId)).toEqual([other, other]);
    expect(noticeBatches.create).not.toHaveBeenCalled();
    expect(noticeBatches.close).not.toHaveBeenCalled();
  });

  it('un tramo después del final: 422 sin crear nada', async () => {
    const { service, enqueued } = setup();
    const error = await service
      .enqueue({ sourceJobId: SOURCE_ID, segments: [{ start: 70, end: 80 }] }, requester)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EditError);
    expect(error).toMatchObject({ code: 'SEGMENT_OUT_OF_RANGE', status: 422 });
    expect(enqueued).toHaveLength(0);
  });

  it('un archivo sin video: 422', async () => {
    const { service } = setup({ media: { ...video, video: null } });
    await expect(service.getSource(SOURCE_ID)).rejects.toMatchObject({ code: 'NO_VIDEO' });
  });

  it('un origen expirado: 410; uno que no existe: 404', async () => {
    const { service } = setup({
      source: { id: SOURCE_ID, type: 'download', status: 'expired' } as JobRecord,
    });
    await expect(service.getSource(SOURCE_ID)).rejects.toMatchObject({ status: 410 });
    await expect(service.getSource(OTHER)).rejects.toMatchObject({ status: 404 });
  });

  it('getSource devuelve los cuadros por segundo para ir cuadro por cuadro', async () => {
    const { service } = setup();
    const source = await service.getSource(SOURCE_ID);
    expect(source.media).toMatchObject({ hasVideo: true, frameRate: 30, durationSeconds: 60 });
  });

  it('tramos desordenados: los rechaza el esquema', async () => {
    const { service } = setup();
    await expect(
      service.enqueue(
        {
          sourceJobId: SOURCE_ID,
          segments: [
            { start: 30, end: 40 },
            { start: 0, end: 10 },
          ],
        },
        requester,
      ),
    ).rejects.toThrow();
  });
});
