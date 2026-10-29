import type { HealthResponse, ToolName } from '@sti-catcher/shared';
import { formatBytes, formatUptime } from '../../lib/format.ts';
import { SelfTestCard } from './SelfTestCard.tsx';
import { useHealth } from './useHealth.ts';

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  'yt-dlp': 'Descarga de videos por URL',
  ffmpeg: 'Conversión y procesamiento',
  ffprobe: 'Análisis de archivos',
  deno: 'Runtime de JavaScript que necesita yt-dlp para YouTube',
};

export function StatusPage() {
  const { state, isRefreshing, refresh, reload } = useHealth();

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Estado del sistema</h1>
          <p className="muted">Herramientas instaladas, espacio en disco y trabajos activos.</p>
        </div>
        <button type="button" className="button" onClick={refresh} disabled={isRefreshing}>
          {isRefreshing ? 'Consultando…' : 'Actualizar'}
        </button>
      </header>

      {state.kind === 'loading' && <p className="muted">Consultando el servidor…</p>}
      {state.kind === 'error' && (
        <div className="alert alert-error" role="alert">
          {state.message}
        </div>
      )}
      {state.kind === 'ready' && <StatusDetails health={state.data} />}
      {/* Cada cambio de estado de la prueba actualiza el contador de trabajos. */}
      <SelfTestCard onJobUpdated={reload} />
    </section>
  );
}

function StatusDetails({ health }: { health: HealthResponse }) {
  const usedRatio =
    health.disk.totalBytes > 0 ? 1 - health.disk.freeBytes / health.disk.totalBytes : 0;
  const checkedAt = new Date(health.toolsCheckedAt).toLocaleTimeString('es-AR');

  return (
    <>
      {health.status === 'ok' ? (
        <div className="alert alert-ok" role="status">
          Todo funciona correctamente.
        </div>
      ) : (
        <div className="alert alert-warn" role="status">
          Hay problemas: revisá los puntos marcados abajo.
        </div>
      )}

      <div className="card">
        <h2>Herramientas</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Herramienta</th>
              <th scope="col">Versión</th>
              <th scope="col">Para qué se usa</th>
            </tr>
          </thead>
          <tbody>
            {health.tools.map((tool) => (
              <tr key={tool.name}>
                <th scope="row">
                  <code>{tool.name}</code>
                </th>
                <td>
                  {tool.version !== null ? (
                    <span className="badge badge-ok">{tool.version}</span>
                  ) : (
                    <span className="badge badge-error" title={tool.error ?? undefined}>
                      {tool.error ?? 'No disponible'}
                    </span>
                  )}
                </td>
                <td className="muted">{TOOL_DESCRIPTIONS[tool.name]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Versiones consultadas a las {checkedAt}.</p>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Disco</h2>
          <p className="stat">{formatBytes(health.disk.freeBytes)} libres</p>
          <div
            className={`meter ${health.disk.isLow ? 'meter-low' : ''}`}
            role="meter"
            aria-label="Espacio usado"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usedRatio * 100)}
          >
            <div className="meter-fill" style={{ width: `${usedRatio * 100}%` }} />
          </div>
          <p className="muted small">
            De {formatBytes(health.disk.totalBytes)}. Mínimo para aceptar trabajos:{' '}
            {formatBytes(health.disk.minFreeBytes)}.
          </p>
          {health.disk.isLow && (
            <p className="text-error small">
              Espacio insuficiente: no se van a aceptar trabajos nuevos.
            </p>
          )}
        </div>

        <div className="card">
          <h2>Trabajos</h2>
          <p className="stat">
            {health.jobs.running} en curso · {health.jobs.queued} en cola
          </p>
          <p className="muted small">Máximo simultáneo: {health.jobs.maxConcurrent}.</p>
        </div>

        <div className="card">
          <h2>Servidor</h2>
          <p className="stat">v{health.app.version}</p>
          <p className="muted small">
            Node {health.app.nodeVersion} · activo hace {formatUptime(health.app.uptimeSeconds)}
          </p>
        </div>
      </div>
    </>
  );
}
