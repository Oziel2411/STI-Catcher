import {
  ArrowsInSimpleIcon,
  ArrowsLeftRightIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  PulseIcon,
  RecordIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { ActiveJobsResponse } from '@sti-catcher/shared';
import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { SessionBox } from '../features/auth/SessionBox.tsx';
import { RecorderProvider } from '../features/recording/RecorderProvider.tsx';
import { RecordingNavBadge } from '../features/recording/RecordingNavBadge.tsx';
import { useActiveJobCounts } from '../hooks/useActiveJobCounts.ts';
import { NavCount } from './NavCount.tsx';

const NAV_ITEMS: readonly {
  to: string;
  label: string;
  /** Nombre en pantallas angostas, si el completo es largo. */
  shortLabel?: string;
  icon: Icon;
  /** Qué trabajos en curso se cuentan junto al nombre. */
  count?: keyof ActiveJobsResponse;
}[] = [
  { to: '/descargar', label: 'Descargar', icon: DownloadSimpleIcon, count: 'download' },
  { to: '/grabar', label: 'Grabar pantalla', shortLabel: 'Grabar', icon: RecordIcon },
  { to: '/convertir', label: 'Convertir', icon: ArrowsLeftRightIcon, count: 'conversion' },
  { to: '/comprimir', label: 'Comprimir', icon: ArrowsInSimpleIcon, count: 'compression' },
  { to: '/historial', label: 'Historial', icon: ClockCounterClockwiseIcon },
  { to: '/estado', label: 'Estado', icon: PulseIcon },
];

/**
 * Barra arriba en dos niveles (D-106): marca y cuenta; abajo, las secciones en
 * un grupo de botones centrado (D-107).
 * Queda fija al bajar por la página. La grabación vive acá (`RecorderProvider`)
 * para que siga al cambiar de sección.
 */
export function Layout() {
  const counts = useActiveJobCounts();
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);

  // En angosto las secciones se deslizan de costado: la activa, a la vista.
  // Se repite cuando carga la letra, que cambia el ancho de cada sección.
  useEffect(() => {
    const reveal = () => {
      navRef.current
        ?.querySelector('.nav-link.active')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    reveal();
    void document.fonts.ready.then(reveal);
  }, [pathname]);
  return (
    <RecorderProvider>
      <div className="layout">
        <header className="topbar">
          <div className="topbar-main">
            <span className="brand">
              {/* El nombre va al lado: el logo es decorativo para los lectores de pantalla. */}
              <img className="brand-logo" src="/logo-128.png" alt="" width={34} height={34} />
              <span className="brand-name">
                <span className="brand-accent">STI</span>-Catcher
              </span>
            </span>
            <SessionBox />
          </div>
          <nav ref={navRef} aria-label="Secciones" className="topbar-nav">
            <ul className="nav">
              {NAV_ITEMS.map(({ to, label, shortLabel, icon: ItemIcon, count }) => (
                <li key={to}>
                  <NavLink to={to} className="nav-link">
                    <ItemIcon size={18} aria-hidden="true" className="nav-icon" />
                    {shortLabel === undefined ? (
                      label
                    ) : (
                      <>
                        <span className="nav-label-long">{label}</span>
                        <span className="nav-label-short">{shortLabel}</span>
                      </>
                    )}
                    {to === '/grabar' ? (
                      <RecordingNavBadge processing={counts.recording} />
                    ) : (
                      count !== undefined && <NavCount value={counts[count]} />
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <main className="content">
          <Outlet />
        </main>
        <footer className="page-footer">Usar solo con contenido propio o con autorización.</footer>
      </div>
    </RecorderProvider>
  );
}
