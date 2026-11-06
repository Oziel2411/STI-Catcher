import { PASSWORD_MIN_LENGTH } from '@sti-catcher/shared';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { resetPassword } from '../../api/auth.ts';
import { AuthCard } from './LoginPage.tsx';
import './auth.css';

/**
 * El token del link del mail (`/restablecer#token=…`). Va después de `#`
 * para que el navegador no lo mande al server (ni quede en sus logs). Al
 * leerlo se borra de la barra de direcciones y del historial. Se guarda una
 * sola vez: en modo estricto React llama dos veces al inicializador.
 */
let takenToken: string | null | undefined;
function takeTokenFromUrl(): string | null {
  if (takenToken === undefined) {
    takenToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (window.location.hash !== '') {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }
  return takenToken;
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'No se pudo cambiar la contraseña.';

/** Elegir una contraseña nueva con el link del mail (D-100). */
export function ResetPasswordPage() {
  const [token] = useState(takeTokenFromUrl);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const goToLogin = () => {
    window.location.assign('/');
  };

  if (token === null) {
    return (
      <AuthCard title="Link incompleto">
        <p className="alert alert-error">
          Al link le falta una parte. Abrilo de nuevo desde el mail, o pedí uno nuevo desde
          «¿Olvidaste tu contraseña?».
        </p>
        <button type="button" className="button button-block" onClick={goToLogin}>
          Ir a ingresar
        </button>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="Contraseña nueva guardada">
        <p className="alert alert-ok" role="status">
          Listo. Ya podés ingresar con tu contraseña nueva. Si tenías la app abierta en otra PC, ahí
          vas a tener que ingresar de nuevo.
        </p>
        <button type="button" className="button button-block" onClick={goToLogin}>
          Ir a ingresar
        </button>
      </AuthCard>
    );
  }

  const problem =
    password.length > 0 && password.length < PASSWORD_MIN_LENGTH
      ? `La contraseña tiene que tener al menos ${String(PASSWORD_MIN_LENGTH)} caracteres.`
      : repeat.length > 0 && repeat !== password
        ? 'Las dos contraseñas no coinciden.'
        : null;
  const ready = password.length >= PASSWORD_MIN_LENGTH && repeat === password;

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready) return;
    setSending(true);
    setError(null);
    resetPassword(token, password)
      .then(() => {
        setDone(true);
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason));
        setSending(false);
      });
  };

  return (
    <AuthCard title="Elegí una contraseña nueva" onSubmit={submit}>
      <label className="field login-field">
        <span>Contraseña nueva (al menos {PASSWORD_MIN_LENGTH} caracteres)</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </label>
      <label className="field login-field">
        <span>Repetila</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={repeat}
          onChange={(event) => {
            setRepeat(event.target.value);
          }}
        />
      </label>
      {(error ?? problem) !== null && (
        <p className="alert alert-error" role="alert">
          {error ?? problem}
        </p>
      )}
      <button className="button button-block" type="submit" disabled={!ready || sending}>
        {sending ? 'Guardando…' : 'Guardar contraseña'}
      </button>
      <button type="button" className="session-logout" onClick={goToLogin}>
        Volver a ingresar
      </button>
    </AuthCard>
  );
}
