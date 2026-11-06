import { PASSWORD_MIN_LENGTH } from '@sti-catcher/shared';
import type { UserRole, UserSummary } from '@sti-catcher/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SubmitEvent } from 'react';
import {
  createUser,
  generatePassword,
  listUsers,
  setProvisionalPassword,
  updateUser,
} from '../../api/users.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useSession } from '../auth/session-context.ts';
import '../auth/auth.css';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'No se pudo completar la acción.';

type Notice = { ok: boolean; text: string };

/**
 * Administración de cuentas (D-100), solo para administradores: crear,
 * desactivar, cambiar rol o nombre y poner una contraseña provisoria.
 */
export function UsersPage() {
  const { user: me } = useSession();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    listUsers(signal)
      .then((list) => {
        setUsers(list);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (signal?.aborted === true) return;
        setLoadError(errorMessage(error));
      });
  }, []);

  useEffect(() => {
    if (me.role !== 'admin') return;
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, me.role]);

  if (me.role !== 'admin') {
    return (
      <section className="page">
        <h1>Usuarios</h1>
        <p className="muted">Solo un administrador puede administrar las cuentas.</p>
      </section>
    );
  }

  const replace = (updated: UserSummary) => {
    setUsers((current) => current?.map((u) => (u.id === updated.id ? updated : u)) ?? null);
  };

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Usuarios</h1>
          <p className="muted">
            Las cuentas para ingresar a STI-Catcher. Ser administrador solo sirve para esta página.
          </p>
        </div>
      </header>
      {notice !== null && (
        <div className={`alert ${notice.ok ? 'alert-ok' : 'alert-error'}`} role="status">
          <p>{notice.text}</p>
        </div>
      )}
      <CreateUserCard
        onCreated={(created, password) => {
          setUsers((current) => (current ? [...current, created] : current));
          setNotice({
            ok: true,
            text: `Cuenta creada. Pasale a ${created.name} su mail (${created.email}) y la contraseña provisoria «${password}»: la va a cambiar al ingresar.`,
          });
        }}
      />
      <div className="card">
        <h2>Cuentas</h2>
        {loadError !== null && <p className="alert alert-error">{loadError}</p>}
        {users === null && loadError === null && <p className="muted small">Cargando…</p>}
        {users !== null && (
          <div className="users-table-wrap">
            <table className="table users-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Mail</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  <th>Último ingreso</th>
                  <th>
                    <span className="visually-hidden">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <UserRow
                    key={user.id}
                    user={user}
                    isMe={user.id === me.id}
                    onUpdated={replace}
                    onNotice={setNotice}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function CreateUserCard({
  onCreated,
}: {
  onCreated: (user: UserSummary, password: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [password, setPassword] = useState(() => generatePassword());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    createUser({ email, name, role, password })
      .then((created) => {
        onCreated(created, password);
        setEmail('');
        setName('');
        setRole('user');
        setPassword(generatePassword());
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason));
      })
      .finally(() => {
        setSending(false);
      });
  };

  return (
    <div className="card">
      <h2>Nueva cuenta</h2>
      <form className="users-create" onSubmit={submit}>
        <label className="field login-field">
          <span>Mail</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </label>
        <label className="field login-field">
          <span>Nombre</span>
          <input
            type="text"
            required
            maxLength={80}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>Rol</span>
          <select
            value={role}
            onChange={(event) => {
              setRole(event.target.value === 'admin' ? 'admin' : 'user');
            }}
          >
            <option value="user">Usuario</option>
            <option value="admin">Administrador</option>
          </select>
        </label>
        <label className="field login-field">
          <span>Contraseña provisoria</span>
          <span className="users-password">
            <input
              type="text"
              required
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="off"
              spellCheck={false}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setPassword(generatePassword());
              }}
            >
              Otra
            </button>
          </span>
        </label>
        <button className="button" type="submit" disabled={sending}>
          {sending ? 'Creando…' : 'Crear cuenta'}
        </button>
      </form>
      {error !== null && (
        <p className="alert alert-error users-form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function UserRow({
  user,
  isMe,
  onUpdated,
  onNotice,
}: {
  user: UserSummary;
  isMe: boolean;
  onUpdated: (user: UserSummary) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const run = (work: () => Promise<UserSummary>, success: (updated: UserSummary) => string) => {
    setBusy(true);
    work()
      .then((updated) => {
        onUpdated(updated);
        onNotice({ ok: true, text: success(updated) });
      })
      .catch((error: unknown) => {
        onNotice({ ok: false, text: errorMessage(error) });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const rename = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = renaming;
    if (name === null) return;
    run(
      () => updateUser(user.id, { name }),
      (updated) => `Nombre cambiado a «${updated.name}».`,
    );
    setRenaming(null);
  };

  const resetPassword = () => {
    const password = generatePassword();
    run(
      () => setProvisionalPassword(user.id, password),
      (updated) =>
        `Contraseña provisoria de ${updated.name}: «${password}». Pasásela: la va a cambiar al ingresar. Sus sesiones abiertas se cerraron.`,
    );
  };

  return (
    <tr className={user.active ? undefined : 'users-inactive'}>
      <td>
        {renaming === null ? (
          <>
            {user.name}
            {isMe && <span className="muted"> (vos)</span>}
          </>
        ) : (
          <form className="users-rename" onSubmit={rename}>
            <input
              type="text"
              aria-label="Nombre nuevo"
              required
              maxLength={80}
              autoFocus
              value={renaming}
              onChange={(event) => {
                setRenaming(event.target.value);
              }}
            />
            <button type="submit" className="button">
              Guardar
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setRenaming(null);
              }}
            >
              Cancelar
            </button>
          </form>
        )}
      </td>
      <td>{user.email}</td>
      <td>
        {user.role === 'admin' ? (
          <span className="badge badge-accent">Administrador</span>
        ) : (
          'Usuario'
        )}
      </td>
      <td>
        {user.active ? (
          <span className="badge badge-ok">Activa</span>
        ) : (
          <span className="badge badge-muted">Desactivada</span>
        )}
        {user.mustChangePassword && <span className="badge badge-muted">Provisoria</span>}
      </td>
      <td className="muted">
        {user.lastLoginAt === null ? 'Nunca' : formatDateTime(user.lastLoginAt)}
      </td>
      <td>
        <div className="users-actions">
          <button
            type="button"
            className="button button-ghost"
            disabled={busy || renaming !== null}
            onClick={() => {
              setRenaming(user.name);
            }}
          >
            Renombrar
          </button>
          <button
            type="button"
            className="button button-ghost"
            disabled={busy}
            onClick={resetPassword}
          >
            Contraseña provisoria
          </button>
          {!isMe && (
            <>
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={() => {
                  const role: UserRole = user.role === 'admin' ? 'user' : 'admin';
                  run(
                    () => updateUser(user.id, { role }),
                    (updated) =>
                      updated.role === 'admin'
                        ? `${updated.name} ahora es administrador.`
                        : `${updated.name} ya no es administrador.`,
                  );
                }}
              >
                {user.role === 'admin' ? 'Quitar admin' : 'Hacer admin'}
              </button>
              <button
                type="button"
                className={`button button-ghost ${user.active ? 'button-ghost-danger' : ''}`}
                disabled={busy}
                onClick={() => {
                  run(
                    () => updateUser(user.id, { active: !user.active }),
                    (updated) =>
                      updated.active
                        ? `${updated.name} puede volver a ingresar.`
                        : `${updated.name} ya no puede ingresar. Sus sesiones abiertas se cerraron.`,
                  );
                }}
              >
                {user.active ? 'Desactivar' : 'Activar'}
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
