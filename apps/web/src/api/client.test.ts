import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiGet, httpErrorMessage, NETWORK_ERROR_MESSAGE } from './client.ts';

describe('httpErrorMessage', () => {
  it('502/503/504: el server se está reiniciando', () => {
    for (const status of [502, 503, 504]) {
      expect(httpErrorMessage(status)).toMatch(/reiniciándose/);
    }
  });

  it('otros casos conocidos, sin el número', () => {
    expect(httpErrorMessage(413)).toMatch(/demasiado grande/);
    expect(httpErrorMessage(429)).toMatch(/demasiados pedidos/);
    expect(httpErrorMessage(500)).toMatch(/error inesperado/);
  });

  it('el resto dice el código, sin la palabra «servidor respondió»', () => {
    expect(httpErrorMessage(418)).toBe('No se pudo completar el pedido (error 418).');
  });
});

describe('apiGet', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('un 502 sin cuerpo de la app usa el mensaje amigable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('Bad Gateway', { status: 502 }))),
    );
    await expect(apiGet('/api/health', z.object({}))).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 502,
      message: httpErrorMessage(502),
    });
  });

  it('el mensaje de la app tiene prioridad', async () => {
    const body = JSON.stringify({
      error: { code: 'NOT_FOUND', message: 'No existe ese trabajo.' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body, { status: 404 }))),
    );
    await expect(apiGet('/api/jobs/x', z.object({}))).rejects.toMatchObject({
      message: 'No existe ese trabajo.',
    });
  });

  it('sin conexión', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(apiGet('/api/health', z.object({}))).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: NETWORK_ERROR_MESSAGE,
    });
  });
});
