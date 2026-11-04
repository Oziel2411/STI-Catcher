import {
  ArrowsLeftRightIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  PulseIcon,
  RecordIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { NavLink, Outlet } from 'react-router';
import { RecorderProvider } from '../features/recording/RecorderProvider.tsx';
import { RecordingNavBadge } from '../features/recording/RecordingNavBadge.tsx';

const NAV_ITEMS: readonly { to: string; label: string; icon: Icon }[] = [
  { to: '/descargar', label: 'Descargar', icon: DownloadSimpleIcon },
  { to: '/grabar', label: 'Grabar pantalla', icon: RecordIcon },
  { to: '/convertir', label: 'Convertir', icon: ArrowsLeftRightIcon },
  { to: '/historial', label: 'Historial', icon: ClockCounterClockwiseIcon },
  { to: '/estado', label: 'Estado', icon: PulseIcon },
];

/**
 * Barra lateral (en pantallas angostas pasa a ser una barra arriba) + contenido.
 * La grabación vive acá (`RecorderProvider`) para que siga al cambiar de sección.
 */
export function Layout() {
  return (
    <RecorderProvider>
      <div className="layout">
        <aside className="sidebar">
          <span className="brand">
            <img
              className="brand-logo"
              src="/logo-128.png"
              alt="Centro de Capitanes de Ultramar y Oficiales de la Marina Mercante"
              width={28}
              height={28}
            />
            STI-Catcher
          </span>
          <nav aria-label="Secciones">
            <ul className="nav">
              {NAV_ITEMS.map(({ to, label, icon: ItemIcon }) => (
                <li key={to}>
                  <NavLink to={to} className="nav-link">
                    <ItemIcon size={16} aria-hidden="true" className="nav-icon" />
                    {label}
                    {to === '/grabar' && <RecordingNavBadge />}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <p className="sidebar-footer">Usar solo con contenido propio o con autorización.</p>
        </aside>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </RecorderProvider>
  );
}
