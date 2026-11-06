import { PASSWORD_MIN_LENGTH } from '@sti-catcher/shared';
import type { SessionUser } from '@sti-catcher/shared';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { changeMyPassword } from '../../api/users.ts';

type Props = {
  onChanged: (user: SessionUser) => void;
  /** Texto del botón. */
  submitLabel?: string;
  /** Rótulo del campo de la contraseña actual (con provisoria, «Contraseña provisoria»). */
  currentLabel?: string;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'No se pudo cambiar la contraseña.';

/** Cambiar la propia contraseña: la actual y la nueva dos veces (D-100). */
export function ChangePasswordForm({
  onChanged,
  submitLabel = 'Cambiar contraseña',
  currentLabel = 'Contraseña actual',
}: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Los problemas que se ven sin preguntarle al server.
  const problem =
    next.length > 0 && next.length < PASSWORD_MIN_LENGTH
      ? `La contraseña nueva tiene que tener al menos ${String(PASSWORD_MIN_LENGTH)} caracteres.`
      : repeat.length > 0 && repeat !== next
        ? 'Las dos contraseñas nuevas no coinciden.'
        : null;
  const ready = current.length > 0 && next.length >= PASSWORD_MIN_LENGTH && repeat === next;

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready) return;
    setSending(true);
    setError(null);
    changeMyPassword(current, next)
      .then((user) => {
        setCurrent('');
        setNext('');
        setRepeat('');
        onChanged(user);
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason));
      })
      .finally(() => {
        setSending(false);
      });
  };

  return (
    <form className="account-form" onSubmit={submit}>
      <label className="field login-field">
        <span>{currentLabel}</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
          }}
        />
      </label>
      <label className="field login-field">
        <span>Contraseña nueva (al menos {PASSWORD_MIN_LENGTH} caracteres)</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={next}
          onChange={(event) => {
            setNext(event.target.value);
          }}
        />
      </label>
      <label className="field login-field">
        <span>Repetí la contraseña nueva</span>
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
      <button className="button" type="submit" disabled={!ready || sending}>
        {sending ? 'Guardando…' : submitLabel}
      </button>
    </form>
  );
}
