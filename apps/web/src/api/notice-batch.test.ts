import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNoticeBatch } from './notice-batch.ts';

const BATCH = '33333333-3333-4333-8333-333333333333';
const ANA = '11111111-1111-4111-8111-111111111111';

function stubFetch(openStatus = 201) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push(url);
      if (url === '/api/notice-batches') {
        return Promise.resolve(
          openStatus === 201
            ? Response.json({ batchId: BATCH }, { status: 201 })
            : new Response('Bad Gateway', { status: openStatus }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  );
  return calls;
}

describe('withNoticeBatch (D-105)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('varios trabajos con aviso: abre el pedido, lo pasa y lo cierra al final', async () => {
    const calls = stubFetch();
    const seen: (string | null)[] = [];
    await withNoticeBatch([ANA], 3, (batchId) => {
      seen.push(batchId);
      return Promise.resolve();
    });
    expect(seen).toEqual([BATCH]);
    expect(calls).toEqual(['/api/notice-batches', `/api/notice-batches/${BATCH}/close`]);
  });

  it('lo cierra aunque crear los trabajos falle', async () => {
    const calls = stubFetch();
    await expect(
      withNoticeBatch([ANA], 2, () => Promise.reject(new Error('sin red'))),
    ).rejects.toThrow('sin red');
    expect(calls.at(-1)).toBe(`/api/notice-batches/${BATCH}/close`);
  });

  it('uno solo, o sin nadie a quien avisar: no abre pedido', async () => {
    const calls = stubFetch();
    const seen: (string | null)[] = [];
    const create = (batchId: string | null) => {
      seen.push(batchId);
      return Promise.resolve();
    };
    await withNoticeBatch([ANA], 1, create);
    await withNoticeBatch([], 5, create);
    expect(seen).toEqual([null, null]);
    expect(calls).toEqual([]);
  });

  it('si no se puede abrir el pedido, cada trabajo avisa solo', async () => {
    stubFetch(502);
    const seen: (string | null)[] = [];
    await withNoticeBatch([ANA], 2, (batchId) => {
      seen.push(batchId);
      return Promise.resolve();
    });
    expect(seen).toEqual([null]);
  });
});
