import type { SessionUser } from '@sti-catcher/shared';
import { ChangePasswordForm } from './ChangePasswordForm.tsx';
import './auth.css';

type Props = {
  onChanged: (user: SessionUser) => void;
  onLogout: () => void;
};

/** Con una contraseña provisoria hay que cambiarla antes de usar la app (D-104). */
export function ForcedPasswordChange({ onChanged, onLogout }: Props) {
  return (
    <main className="login">
      <div className="login-card card">
        <div className="login-brand">
          <img
            className="brand-logo"
            src="/logo-128.png"
            alt="Centro de Capitanes de Ultramar y Oficiales de la Marina Mercante"
            width={40}
            height={40}
          />
          <h1>Elegí tu contraseña</h1>
        </div>
        <p className="muted small login-help">
          Tu contraseña es provisoria. Elegí una nueva para empezar a usar STI-Catcher: solo vos la
          vas a saber.
        </p>
        <ChangePasswordForm
          onChanged={onChanged}
          currentLabel="Contraseña provisoria"
          submitLabel="Guardar y entrar"
        />
        <button type="button" className="session-logout" onClick={onLogout}>
          Salir
        </button>
      </div>
    </main>
  );
}
