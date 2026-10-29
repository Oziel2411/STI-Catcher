import { NavLink, Outlet } from 'react-router';

const NAV_ITEMS = [
  { to: '/descargar', label: 'Descargar' },
  { to: '/grabar', label: 'Grabar pantalla' },
  { to: '/convertir', label: 'Convertir' },
  { to: '/historial', label: 'Historial' },
  { to: '/estado', label: 'Estado' },
] as const;

export function Layout() {
  return (
    <div className="layout">
      <header className="topbar">
        <span className="brand">STI-Catcher</span>
        <nav aria-label="Secciones">
          <ul className="nav">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} className="nav-link">
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
      <footer className="footer">Usar solo con contenido propio o con autorización.</footer>
    </div>
  );
}
