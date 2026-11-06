import type { SessionUser } from '@sti-catcher/shared';
import { createContext, useContext } from 'react';

export type SessionContextValue = {
  user: SessionUser;
  /** Cierra la sesión y vuelve a la pantalla de ingreso. */
  logout: () => void;
};

export const SessionContext = createContext<SessionContextValue | null>(null);

/** La cuenta con la que se ingresó. Solo se usa dentro de `AuthGate`. */
export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession fuera de AuthGate');
  return value;
}
