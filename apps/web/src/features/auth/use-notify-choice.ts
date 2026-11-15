import { useState } from 'react';
import { useSession } from './session-context.ts';

// Por cuenta: si otra persona ingresa en la misma PC, no hereda la elección.
const storageKey = (userId: string, key: string) => `sti.notify.${userId}.${key}`;

/**
 * A quién avisar por mail (D-104), recordado por cuenta y página en `localStorage`.
 * `defaultMe`: si no hay nada guardado, «a mí» viene tildado.
 */
export function useNotifyChoice(key: string, defaultMe: boolean) {
  const { user } = useSession();
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey(user.id, key)) ?? 'null');
      if (Array.isArray(stored)) return stored.filter((id): id is string => typeof id === 'string');
    } catch {
      // Lo guardado no sirve: se usa el valor por defecto.
    }
    return defaultMe ? [user.id] : [];
  });
  /**
   * `persist: false`: cambio automático (D-109), no se recuerda para la próxima
   * vez. `stored`: lo que se recuerda, si no es igual a lo elegido ahora.
   */
  const change = (next: string[], persist = true, stored: string[] = next) => {
    setIds(next);
    if (!persist) return;
    try {
      localStorage.setItem(storageKey(user.id, key), JSON.stringify(stored));
    } catch {
      // Sin localStorage (modo privado estricto): se recuerda solo en esta pestaña.
    }
  };
  return [ids, change] as const;
}
