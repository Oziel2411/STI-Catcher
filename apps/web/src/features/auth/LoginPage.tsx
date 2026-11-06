import type { SessionUser } from '@sti-catcher/shared';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { login } from '../../api/auth.ts';
import './auth.css';

type Props = {
  onLogin: (user: SessionUser) => void;
  /** Texto arriba del formulario (p. ej. cuando venció la sesión). */
  notice?: string;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'No se pudo ingresar.';

/** Pantalla de ingreso (D-100): mail y contraseña. Las cuentas las crea un administrador. */
export function LoginPage({ onLogin, notice }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    login(email, password)
      .then((user) => {
        setPassword('');
        onLogin(user);
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason));
        setSending(false);
      });
  };

  return (
    <main className="login">
      <form className="login-card card" onSubmit={submit} aria-labelledby="login-title">
        <div className="login-brand">
          <img
            className="brand-logo"
            src="/logo-128.png"
            alt="Centro de Capitanes de Ultramar y Oficiales de la Marina Mercante"
            width={40}
            height={40}
          />
          <h1 id="login-title">STI-Catcher</h1>
        </div>
        {notice !== undefined && <p className="alert alert-warn">{notice}</p>}
        <label className="field login-field">
          <span>Mail</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </label>
        <label className="field login-field">
          <span>Contraseña</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </label>
        {error !== null && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <button className="button button-block" type="submit" disabled={sending}>
          {sending ? 'Ingresando…' : 'Ingresar'}
        </button>
        <p className="muted small login-help">
          ¿No tenés cuenta o te olvidaste la contraseña? Pedísela a un administrador de STI-Catcher.
        </p>
      </form>
    </main>
  );
}
