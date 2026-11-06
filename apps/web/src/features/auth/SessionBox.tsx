import { NavLink } from 'react-router';
import { useSession } from './session-context.ts';

/** Cuenta actual, «Mi cuenta», «Usuarios» (admins) y «Salir», en la barra lateral (D-100). */
export function SessionBox() {
  const { user, logout } = useSession();
  return (
    <div className="session-box">
      <span className="session-name" title={user.email}>
        {user.name}
      </span>
      <span className="session-links">
        <NavLink to="/cuenta" className="session-link">
          Mi cuenta
        </NavLink>
        {user.role === 'admin' && (
          <NavLink to="/usuarios" className="session-link">
            Usuarios
          </NavLink>
        )}
        <button type="button" className="session-logout" onClick={logout}>
          Salir
        </button>
      </span>
    </div>
  );
}
