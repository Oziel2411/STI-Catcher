import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { renameMe } from '../../api/users.ts';
import { ChangePasswordForm } from './ChangePasswordForm.tsx';
import { useSession } from './session-context.ts';
import './auth.css';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'No se pudo guardar.';

/** Mi cuenta (D-104): nombre que se ve en el historial y cambio de contraseña. */
export function AccountPage() {
  const { user, updateUser } = useSession();
  const [name, setName] = useState(user.name);
  const [savingName, setSavingName] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const saveName = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingName(true);
    setMessage(null);
    renameMe(name)
      .then((updated) => {
        updateUser(updated);
        setName(updated.name);
        setMessage({ ok: true, text: 'Nombre guardado.' });
      })
      .catch((error: unknown) => {
        setMessage({ ok: false, text: errorMessage(error) });
      })
      .finally(() => {
        setSavingName(false);
      });
  };

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Mi cuenta</h1>
          <p className="muted">
            {user.email}
            {user.role === 'admin' && ' · Administrador'}
          </p>
        </div>
      </header>
      {message !== null && (
        <p className={`alert ${message.ok ? 'alert-ok' : 'alert-error'}`} role="status">
          {message.text}
        </p>
      )}
      <div className="account-grid">
        <div className="card">
          <h2>Nombre</h2>
          <p className="muted small">Es como te ven tus compañeros en el historial.</p>
          <form className="account-form" onSubmit={saveName}>
            <label className="field login-field">
              <span>Nombre</span>
              <input
                type="text"
                autoComplete="name"
                required
                maxLength={80}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </label>
            <button
              className="button"
              type="submit"
              disabled={savingName || name.trim() === '' || name.trim() === user.name}
            >
              {savingName ? 'Guardando…' : 'Guardar nombre'}
            </button>
          </form>
        </div>
        <div className="card">
          <h2>Contraseña</h2>
          <p className="muted small">
            Al cambiarla se cierran tus sesiones en otras PCs; en esta seguís adentro.
          </p>
          <ChangePasswordForm
            onChanged={(updated) => {
              updateUser(updated);
              setMessage({ ok: true, text: 'Contraseña cambiada.' });
            }}
          />
        </div>
      </div>
    </section>
  );
}
