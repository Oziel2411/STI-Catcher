import { TOOL_NAMES } from '@sti-catcher/shared';
import type { HealthResponse, JobCounts, ToolName, ToolStatus } from '@sti-catcher/shared';
import type { DiskSpaceReader } from '../../adapters/disk.ts';
import type { ToolVersionReader } from '../../adapters/tool-version.ts';

export type HealthServiceDeps = {
  appVersion: string;
  toolPaths: Record<ToolName, string>;
  storageDir: string;
  minFreeDiskBytes: number;
  readToolVersion: ToolVersionReader;
  readDiskSpace: DiskSpaceReader;
  /** Cantidad de jobs. Hasta la Fase 2 devuelve ceros. */
  getJobCounts: () => JobCounts;
  /** Cuánto se reutilizan las versiones consultadas. */
  toolsCacheMs?: number;
  now?: () => Date;
  uptimeSeconds?: () => number;
};

export type HealthService = {
  getHealth(options?: { refresh?: boolean }): Promise<HealthResponse>;
};

type ToolsSnapshot = { tools: ToolStatus[]; checkedAt: Date };

/**
 * Estado del sistema para `/api/health` y la página Estado.
 *
 * Las versiones se cachean (por defecto 60 s): ejecutar `yt-dlp.exe` tarda
 * 1–3 s porque se autodescomprime, y la página Estado se puede refrescar seguido.
 * Consultas simultáneas comparten la misma ejecución en curso.
 */
export function createHealthService(deps: HealthServiceDeps): HealthService {
  const cacheMs = deps.toolsCacheMs ?? 60_000;
  const now = deps.now ?? (() => new Date());
  const uptime = deps.uptimeSeconds ?? (() => process.uptime());

  let cached: ToolsSnapshot | null = null;
  let inFlight: Promise<ToolsSnapshot> | null = null;

  const checkTools = async (): Promise<ToolsSnapshot> => {
    const tools = await Promise.all(
      TOOL_NAMES.map(async (name): Promise<ToolStatus> => {
        const result = await deps.readToolVersion(name, deps.toolPaths[name]);
        return { name, ...result };
      }),
    );
    return { tools, checkedAt: now() };
  };

  const getTools = (refresh: boolean): Promise<ToolsSnapshot> => {
    const isFresh = cached !== null && now().getTime() - cached.checkedAt.getTime() < cacheMs;
    if (cached !== null && isFresh && !refresh) return Promise.resolve(cached);
    inFlight ??= checkTools()
      .then((snapshot) => {
        cached = snapshot;
        return snapshot;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    async getHealth({ refresh = false } = {}) {
      const [snapshot, disk] = await Promise.all([
        getTools(refresh),
        deps.readDiskSpace(deps.storageDir),
      ]);
      const isLow = disk.freeBytes < deps.minFreeDiskBytes;
      const allToolsOk = snapshot.tools.every((tool) => tool.version !== null);

      return {
        status: allToolsOk && !isLow ? 'ok' : 'degraded',
        app: {
          version: deps.appVersion,
          nodeVersion: process.versions.node,
          uptimeSeconds: Math.floor(uptime()),
        },
        tools: snapshot.tools,
        disk: { ...disk, minFreeBytes: deps.minFreeDiskBytes, isLow },
        jobs: deps.getJobCounts(),
        toolsCheckedAt: snapshot.checkedAt.toISOString(),
      };
    },
  };
}
