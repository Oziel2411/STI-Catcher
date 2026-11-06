import type { SessionUser } from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import type { ReactNode, SubmitEvent } from 'react';
import { fetchAuthOptions, login, requestPasswordReset } from '../../api/auth.ts';
import './auth.css';

type Props = {
  onLogin: (user: SessionUser) => void;
  /** Texto arriba del formulario (p. ej. cuando venció la sesión). */
  notice?: string;
};

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** Tarjeta con el logo, común a ingreso, olvido y contraseña nueva. */
export function AuthCard({
  title,
  children,
  onSubmit,
}: {
  title: string;
  children: ReactNode;
  onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void;
}) {
  const content = (
    <>
      <div className="login-brand">
        <img
          className="brand-logo"
          src="/logo-128.png"
          alt="Centro de Capitanes de Ultramar y Oficiales de la Marina Mercante"
          width={40}
          height={40}
        />
        <h1 id="login-title">{title}</h1>
      </div>
      {children}
    </>
  );
  return (
    <main className="login">
      {onSubmit ? (
        <form className="login-card card" onSubmit={onSubmit} aria-labelledby="login-title">
          {content}
        </form>
      ) : (
        <div className="login-card card">{content}</div>
      )}
    </main>
  );
}

/**
 * Pantalla de ingreso (D-104): mail y contraseña. Si el server puede mandar
 * mails (SMTP y PUBLIC_URL), ofrece «¿Olvidaste tu contraseña?».
 */
export function LoginPage({ onLogin, notice }: Props) {
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetAvailable, setResetAvailable] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAuthOptions(controller.signal).then((options) => {
      if (!controller.signal.aborted) setResetAvailable(options.passwordReset);
    });
    return () => {
      controller.abort();
    };
  }, []);

  const submitLogin = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    login(email, password)
      .then((user) => {
        setPassword('');
        onLogin(user);
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason, 'No se pudo ingresar.'));
        setSending(false);
      });
  };

  const submitForgot = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    requestPasswordReset(email)
      .then(() => {
        setResetSent(true);
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason, 'No se pudo pedir el link.'));
      })
      .finally(() => {
        setSending(false);
      });
  };

  const switchMode = (next: 'login' | 'forgot') => {
    setMode(next);
    setError(null);
    setResetSent(false);
  };

  const emailField = (
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
  );
  const errorAlert = error !== null && (
    <p className="alert alert-error" role="alert">
      {error}
    </p>
  );

  if (mode === 'forgot') {
    return (
      <AuthCard title="¿Olvidaste tu contraseña?" onSubmit={submitForgot}>
        {resetSent ? (
          <p className="alert alert-ok" role="status">
            Si {email.trim()} tiene una cuenta, le llegó un mail con un link para elegir una
            contraseña nueva. El link vale por 1 hora. Si no aparece, revisá la carpeta de spam.
          </p>
        ) : (
          <>
            <p className="muted small login-help">
              Escribí tu mail y te mandamos un link para elegir una contraseña nueva.
            </p>
            {emailField}
            {errorAlert}
            <button className="button button-block" type="submit" disabled={sending}>
              {sending ? 'Enviando…' : 'Mandarme el link'}
            </button>
          </>
        )}
        <button
          type="button"
          className="session-logout"
          onClick={() => {
            switchMode('login');
          }}
        >
          Volver a ingresar
        </button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="STI-Catcher" onSubmit={submitLogin}>
      {notice !== undefined && <p className="alert alert-warn">{notice}</p>}
      {emailField}
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
      {errorAlert}
      <button className="button button-block" type="submit" disabled={sending}>
        {sending ? 'Ingresando…' : 'Ingresar'}
      </button>
      {resetAvailable ? (
        <button
          type="button"
          className="session-logout"
          onClick={() => {
            switchMode('forgot');
          }}
        >
          ¿Olvidaste tu contraseña?
        </button>
      ) : (
        <p className="muted small login-help">
          ¿No tenés cuenta o te olvidaste la contraseña? Pedísela a un administrador de STI-Catcher.
        </p>
      )}
      {resetAvailable && (
        <p className="muted small login-help">¿No tenés cuenta? Pedísela a un administrador.</p>
      )}
    </AuthCard>
  );
}
