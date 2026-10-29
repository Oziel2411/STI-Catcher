import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiErrorSchema, healthResponseSchema } from '@sti-catcher/shared';
import type { HealthResponse } from '@sti-catcher/shared';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.ts';
import type { HealthService } from './modules/health/health-service.ts';

const sampleHealth: HealthResponse = {
  status: 'ok',
  app: { version: '0.1.0', nodeVersion: '24.19.0', uptimeSeconds: 1 },
  tools: [{ name: 'yt-dlp', version: '2026.10.20', error: null }],
  disk: { freeBytes: 10, totalBytes: 20, minFreeBytes: 1, isLow: false },
  jobs: { running: 0, queued: 0, maxConcurrent: 2 },
  toolsCheckedAt: '2026-10-29T12:00:00.000Z',
};

const silent = pino({ level: 'silent' });

async function makeApp(webDistDir: string | null = null) {
  const getHealth = vi.fn<HealthService['getHealth']>(() => Promise.resolve(sampleHealth));
  const app = await buildApp({
    logger: silent,
    services: { health: { getHealth } },
    webDistDir,
    https: null,
  });
  return { app, getHealth };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('devuelve el estado con el contrato de shared', async () => {
    const { app, getHealth } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toEqual(sampleHealth);
    expect(getHealth).toHaveBeenCalledWith({ refresh: false });
  });

  it('pasa refresh=1 al servicio', async () => {
    const { app, getHealth } = await makeApp();
    await app.inject({ method: 'GET', url: '/api/health?refresh=1' });
    expect(getHealth).toHaveBeenCalledWith({ refresh: true });
  });

  it('responde 400 con detalle si el query es inválido', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/health?refresh=si' });
    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.issues?.[0]?.path).toBe('refresh');
  });

  it('responde 500 genérico sin filtrar detalles internos', async () => {
    const { app, getHealth } = await makeApp();
    getHealth.mockRejectedValueOnce(new Error('C:\\ruta\\secreta explotó'));
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secreta');
  });
});

describe('rutas desconocidas', () => {
  it('la API responde 404 en JSON', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/no-existe' });
    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('con build de la web, las rutas de la SPA devuelven index.html', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sti-web-'));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>STI</title>');
    const { app } = await makeApp(dir);

    const spa = await app.inject({ method: 'GET', url: '/historial' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<title>STI</title>');

    const api = await app.inject({ method: 'GET', url: '/api/no-existe' });
    expect(api.statusCode).toBe(404);
  });
});
