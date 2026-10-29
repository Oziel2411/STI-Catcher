import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiErrorSchema, healthResponseSchema } from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, sampleHealth } from '../test/test-app.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('devuelve el estado con el contrato de shared', async () => {
    const { app, getHealth } = await makeTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toEqual(sampleHealth);
    expect(getHealth).toHaveBeenCalledWith({ refresh: false });
  });

  it('pasa refresh=1 al servicio', async () => {
    const { app, getHealth } = await makeTestApp();
    await app.inject({ method: 'GET', url: '/api/health?refresh=1' });
    expect(getHealth).toHaveBeenCalledWith({ refresh: true });
  });

  it('responde 400 con detalle si el query es inválido', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/health?refresh=si' });
    expect(response.statusCode).toBe(400);
    const body = apiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.issues?.[0]?.path).toBe('refresh');
  });

  it('responde 500 genérico sin filtrar detalles internos', async () => {
    const { app, getHealth } = await makeTestApp();
    getHealth.mockRejectedValueOnce(new Error('C:\\ruta\\secreta explotó'));
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secreta');
  });
});

describe('rutas desconocidas', () => {
  it('la API responde 404 en JSON', async () => {
    const { app } = await makeTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/no-existe' });
    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('con build de la web, las rutas de la SPA devuelven index.html', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sti-web-'));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>STI</title>');
    const { app } = await makeTestApp({ webDistDir: dir });

    const spa = await app.inject({ method: 'GET', url: '/historial' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<title>STI</title>');

    const api = await app.inject({ method: 'GET', url: '/api/no-existe' });
    expect(api.statusCode).toBe(404);
  });
});
