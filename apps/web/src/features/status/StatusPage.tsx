import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  HardDrivesIcon,
  PulseIcon,
  QueueIcon,
  DesktopTowerIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { HealthResponse, ToolName } from '@sti-catcher/shared';
import type { ReactNode } from 'react';
import { formatBytes, formatUptime } from '../../lib/format.ts';
import { PageTitle } from '../../components/PageTitle.tsx';
import { MailCard } from './MailCard.tsx';
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
        <PageTitle icon={PulseIcon} title="Estado del sistema">
          Herramientas instaladas, espacio en disco y trabajos activos.
        </PageTitle>
        <button
          type="button"
          className="button button-secondary"
          onClick={refresh}
          disabled={isRefreshing}
        >
          <ArrowsClockwiseIcon
            size={15}
            aria-hidden="true"
            className={isRefreshing ? 'spin' : undefined}
          />
          {isRefreshing ? 'Consultando…' : 'Actualizar'}
        </button>
      </header>

      {state.kind === 'loading' && <StatusSkeleton />}
      {state.kind === 'error' && (
        <div className="alert alert-error" role="alert">
          {state.message}
        </div>
      )}
      {state.kind === 'ready' && <StatusDetails health={state.data} />}
      {/* Cada cambio de estado de la prueba actualiza el contador de trabajos. */}
      <div className="status-tools">
        <SelfTestCard onJobUpdated={reload} />
        <MailCard />
      </div>
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
        <div className="alert alert-ok status-banner" role="status">
          <CheckCircleIcon size={20} aria-hidden="true" />
          Todo funciona correctamente.
        </div>
      ) : (
        <div className="alert alert-warn status-banner" role="status">
          <WarningCircleIcon size={20} aria-hidden="true" />
          Hay problemas: revisá los puntos marcados abajo.
        </div>
      )}

      <div className="grid stat-grid">
        <StatCard icon={HardDrivesIcon} title="Disco" warn={health.disk.isLow}>
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
        </StatCard>

        <StatCard icon={QueueIcon} title="Trabajos">
          <p className="stat">
            {health.jobs.running} en curso · {health.jobs.queued} en cola
          </p>
          <p className="muted small">Máximo simultáneo: {health.jobs.maxConcurrent}.</p>
        </StatCard>

        <StatCard icon={DesktopTowerIcon} title="Servidor">
          <p className="stat">v{health.app.version}</p>
          <p className="muted small">
            Node {health.app.nodeVersion} · activo hace {formatUptime(health.app.uptimeSeconds)}
          </p>
        </StatCard>
      </div>

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
    </>
  );
}

function StatCard({
  icon: CardIcon,
  title,
  warn = false,
  children,
}: {
  icon: Icon;
  title: string;
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`card stat-card ${warn ? 'stat-card-warn' : ''}`}>
      <h2 className="stat-card-title">
        <span className="stat-card-icon" aria-hidden="true">
          <CardIcon size={18} />
        </span>
        {title}
      </h2>
      {children}
    </div>
  );
}

/** Mientras llega la primera respuesta (las versiones tardan unos segundos). */
function StatusSkeleton() {
  return (
    <div aria-busy="true" aria-label="Consultando el servidor…">
      <span className="skeleton skeleton-banner" />
      <div className="grid stat-grid">
        {[0, 1, 2].map((card) => (
          <div key={card} className="card stat-card">
            <span className="skeleton" />
            <span className="skeleton skeleton-lg" />
            <span className="skeleton skeleton-sm" />
          </div>
        ))}
      </div>
      <div className="card">
        {[0, 1, 2, 3].map((row) => (
          <span key={row} className="skeleton skeleton-row" />
        ))}
      </div>
    </div>
  );
}
