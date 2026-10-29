import { describe, expect, it, vi } from 'vitest';
import type { ToolVersionReader } from '../../adapters/tool-version.ts';
import { createHealthService } from './health-service.ts';
import type { HealthServiceDeps } from './health-service.ts';

const GB = 1024 ** 3;

function setup(overrides: Partial<HealthServiceDeps> = {}) {
  let nowMs = Date.parse('2026-10-29T12:00:00Z');
  const readToolVersion = vi.fn<ToolVersionReader>((tool) =>
    Promise.resolve({ version: `${tool}-1.0`, error: null }),
  );
  const deps: HealthServiceDeps = {
    appVersion: '0.1.0',
    toolPaths: { 'yt-dlp': 'y', ffmpeg: 'f', ffprobe: 'p', deno: 'd' },
    storageDir: 'S:\\storage',
    minFreeDiskBytes: 5 * GB,
    readToolVersion,
    readDiskSpace: () => Promise.resolve({ freeBytes: 50 * GB, totalBytes: 100 * GB }),
    getJobCounts: () => ({ running: 0, queued: 0, maxConcurrent: 2 }),
    toolsCacheMs: 60_000,
    now: () => new Date(nowMs),
    uptimeSeconds: () => 12.7,
    ...overrides,
  };
  return {
    service: createHealthService(deps),
    readToolVersion,
    advance: (ms: number) => (nowMs += ms),
  };
}

describe('createHealthService', () => {
  it('reporta ok con todas las herramientas y disco suficiente', async () => {
    const { service } = setup();
    const health = await service.getHealth();
    expect(health.status).toBe('ok');
    expect(health.tools.map((t) => t.name)).toEqual(['yt-dlp', 'ffmpeg', 'ffprobe', 'deno']);
    expect(health.app.uptimeSeconds).toBe(12);
    expect(health.disk).toEqual({
      freeBytes: 50 * GB,
      totalBytes: 100 * GB,
      minFreeBytes: 5 * GB,
      isLow: false,
    });
  });

  it('reporta degraded si falta una herramienta', async () => {
    const { service } = setup({
      readToolVersion: (tool) =>
        Promise.resolve(
          tool === 'deno'
            ? { version: null, error: 'No encontrado' }
            : { version: '1', error: null },
        ),
    });
    expect((await service.getHealth()).status).toBe('degraded');
  });

  it('reporta degraded y isLow con poco disco', async () => {
    const { service } = setup({
      readDiskSpace: () => Promise.resolve({ freeBytes: 1 * GB, totalBytes: 100 * GB }),
    });
    const health = await service.getHealth();
    expect(health.status).toBe('degraded');
    expect(health.disk.isLow).toBe(true);
  });

  it('cachea las versiones y las vuelve a consultar al vencer o con refresh', async () => {
    const { service, readToolVersion, advance } = setup();
    await service.getHealth();
    await service.getHealth();
    expect(readToolVersion).toHaveBeenCalledTimes(4); // una vez por herramienta

    advance(61_000);
    await service.getHealth();
    expect(readToolVersion).toHaveBeenCalledTimes(8);

    await service.getHealth({ refresh: true });
    expect(readToolVersion).toHaveBeenCalledTimes(12);
  });

  it('consultas simultáneas comparten la misma ejecución', async () => {
    const { service, readToolVersion } = setup();
    await Promise.all([service.getHealth(), service.getHealth(), service.getHealth()]);
    expect(readToolVersion).toHaveBeenCalledTimes(4);
  });
});
