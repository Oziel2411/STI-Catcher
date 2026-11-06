import type { SessionUser } from '@sti-catcher/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchCurrentUser, logout as logoutRequest } from '../../api/auth.ts';
import { SESSION_EXPIRED_EVENT } from '../../api/client.ts';
import { startBackgroundClock } from '../recording/background-clock.ts';
import { LoginPage } from './LoginPage.tsx';
import { SessionContext } from './session-context.ts';
import './auth.css';

/**
 * Latido: el server corta la sesión tras 12 h sin uso (D-100). Con la pestaña
 * abierta se mantiene viva aunque nadie la toque (p. ej. esperando una
 * grabación programada). Sale del reloj del Worker: en segundo plano Chrome
 * frena los timers de la página (D-097).
 */
const HEARTBEAT_MS = 10 * 60_000;

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'anonymous' }
  | { status: 'signed-in'; user: SessionUser; expired: boolean };

/**
 * Login obligatorio (D-100). Sin sesión solo se ve la pantalla de ingreso.
 *
 * Si la sesión se corta con la app abierta (se cerró en otra pestaña, o la
 * desactivaron), el ingreso aparece **encima** de la app sin desmontarla:
 * una grabación en curso no se pierde, y al volver a ingresar con la misma
 * cuenta sigue subiendo sus fragmentos. Con otra cuenta se recarga la página.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchCurrentUser(controller.signal)
      .then((user) => {
        setState(user ? { status: 'signed-in', user, expired: false } : { status: 'anonymous' });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'No se pudo conectar con el servidor.',
        });
      });
    return () => {
      controller.abort();
    };
  }, []);

  const signedIn = state.status === 'signed-in';
  useEffect(() => {
    if (!signedIn) return;
    const onExpired = () => {
      setState((current) =>
        current.status === 'signed-in' ? { ...current, expired: true } : current,
      );
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    const stopClock = startBackgroundClock(() => {
      // Un 401 dispara SESSION_EXPIRED_EVENT; un corte de red se ignora.
      fetchCurrentUser().catch(() => undefined);
    }, HEARTBEAT_MS);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      stopClock();
    };
  }, [signedIn]);

  const logout = useCallback(() => {
    void logoutRequest().then(() => {
      // Recargar limpia todo lo que quedó en memoria de la sesión anterior.
      window.location.assign('/');
    });
  }, []);

  const user = state.status === 'signed-in' ? state.user : null;
  const session = useMemo(() => (user ? { user, logout } : null), [user, logout]);

  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <main className="login">
        <p className="alert alert-error" role="alert">
          {state.message} Recargá la página para reintentar.
        </p>
      </main>
    );
  }
  if (state.status === 'anonymous' || session === null) {
    return (
      <LoginPage
        onLogin={(signedUser) => {
          setState({ status: 'signed-in', user: signedUser, expired: false });
        }}
      />
    );
  }

  return (
    <SessionContext.Provider value={session}>
      {children}
      {state.expired && (
        <div className="login-overlay">
          <LoginPage
            notice="La sesión se cerró. Ingresá de nuevo para seguir."
            onLogin={(signedUser) => {
              if (signedUser.id !== session.user.id) {
                window.location.assign('/');
                return;
              }
              setState({ status: 'signed-in', user: signedUser, expired: false });
            }}
          />
        </div>
      )}
    </SessionContext.Provider>
  );
}
