import { CaretDownIcon, SignOutIcon, UserCircleIcon, UsersIcon } from '@phosphor-icons/react';
import { NavLink, useNavigate } from 'react-router';
import { RowMenu } from '../../components/RowMenu.tsx';
import type { RowMenuItem } from '../../components/RowMenu.tsx';
import { initials } from '../../lib/format.ts';
import { useSession } from './session-context.ts';

/**
 * Cuenta actual, «Mi cuenta», «Usuarios» (admins) y «Salir», arriba a la
 * derecha de la barra (D-104, D-106). En pantallas angostas los enlaces van
 * en un menú que se abre desde el círculo con las iniciales.
 */
export function SessionBox() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const isAdmin = user.role === 'admin';
  const avatar = (
    <span className="session-avatar" aria-hidden="true">
      {initials(user.name)}
    </span>
  );
  const menuItems: RowMenuItem[] = [
    {
      key: 'account',
      label: 'Mi cuenta',
      icon: <UserCircleIcon size={16} />,
      onSelect: () => void navigate('/cuenta'),
    },
    ...(isAdmin
      ? [
          {
            key: 'users',
            label: 'Usuarios',
            icon: <UsersIcon size={16} />,
            onSelect: () => void navigate('/usuarios'),
          },
        ]
      : []),
    { key: 'logout', label: 'Salir', icon: <SignOutIcon size={16} />, onSelect: logout },
  ];

  return (
    <div className="session-box">
      <span className="session-full">
        {avatar}
        <span className="session-name" title={user.email}>
          {user.name}
        </span>
        <span className="session-sep" aria-hidden="true" />
        <NavLink to="/cuenta" className="session-link">
          <UserCircleIcon size={16} aria-hidden="true" />
          Mi cuenta
        </NavLink>
        {isAdmin && (
          <NavLink to="/usuarios" className="session-link">
            <UsersIcon size={16} aria-hidden="true" />
            Usuarios
          </NavLink>
        )}
        <button type="button" className="session-link session-logout" onClick={logout}>
          <SignOutIcon size={16} aria-hidden="true" />
          Salir
        </button>
      </span>
      <span className="session-compact">
        <RowMenu
          label={`Cuenta de ${user.name}`}
          items={menuItems}
          triggerClassName="session-menu-button"
          trigger={
            <>
              {avatar}
              <CaretDownIcon size={12} aria-hidden="true" className="session-caret" />
            </>
          }
        />
      </span>
    </div>
  );
}
