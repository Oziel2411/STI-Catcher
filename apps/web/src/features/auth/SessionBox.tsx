import { useSession } from './session-context.ts';

/** Cuenta actual y «Salir», en la barra lateral (D-100). */
export function SessionBox() {
  const { user, logout } = useSession();
  return (
    <div className="session-box">
      <span className="session-name" title={user.email}>
        {user.name}
      </span>
      <button type="button" className="session-logout" onClick={logout}>
        Salir
      </button>
    </div>
  );
}
