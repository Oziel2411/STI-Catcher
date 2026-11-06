import { EnvelopeSimpleIcon, XIcon } from '@phosphor-icons/react';
import { mailStatusResponseSchema, userDirectoryResponseSchema } from '@sti-catcher/shared';
import type { UserDirectoryResponse } from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client.ts';
import { useSession } from './session-context.ts';
import './auth.css';

type DirectoryUser = UserDirectoryResponse['users'][number];
type NotifyOptions = { mailConfigured: boolean; users: DirectoryUser[] };

// Una consulta por carga de página: el mail y la lista de cuentas cambian poco.
let cached: Promise<NotifyOptions> | null = null;
function loadOptions(): Promise<NotifyOptions> {
  cached ??= Promise.all([
    apiGet('/api/mail', mailStatusResponseSchema),
    apiGet('/api/users/directory', userDirectoryResponseSchema),
  ])
    .then(([mail, directory]) => ({ mailConfigured: mail.configured, users: directory.users }))
    .catch(() => {
      cached = null; // se reintenta la próxima vez
      return { mailConfigured: false, users: [] };
    });
  return cached;
}

type Props = {
  value: string[];
  onChange: (ids: string[]) => void;
  /** «la grabación», «las descargas»… para el texto de ayuda. */
  what: string;
  disabled?: boolean;
};

/**
 * «Avisar por mail»: a mí y a los compañeros elegidos, cuando termina o falla
 * (D-104). Sin servidor de correo no se muestra. Las cuentas desactivadas que
 * hubieran quedado elegidas se descartan solas.
 */
export function NotifyPicker({ value, onChange, what, disabled = false }: Props) {
  const { user } = useSession();
  const [options, setOptions] = useState<NotifyOptions | null>(null);

  useEffect(() => {
    let active = true;
    void loadOptions().then((loaded) => {
      if (active) setOptions(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  if (options === null || !options.mailConfigured) return null;

  const known = new Set(options.users.map((u) => u.id));
  const selected = value.filter((id) => known.has(id));
  const me = selected.includes(user.id);
  const others = options.users.filter((u) => u.id !== user.id && selected.includes(u.id));
  const available = options.users.filter((u) => u.id !== user.id && !selected.includes(u.id));

  const toggleMe = (checked: boolean) => {
    onChange(checked ? [user.id, ...selected] : selected.filter((id) => id !== user.id));
  };

  return (
    <fieldset className="notify-picker" disabled={disabled}>
      <legend className="notify-legend">
        <EnvelopeSimpleIcon size={16} aria-hidden="true" />
        Avisar por mail
      </legend>
      <p className="muted small notify-help">
        Cuando {what} termine o falle, le llega un mail a quien elijas.
      </p>
      <div className="notify-row">
        <label className="choice">
          <input
            type="checkbox"
            checked={me}
            onChange={(event) => {
              toggleMe(event.target.checked);
            }}
          />
          A mí
        </label>
        {others.map((u) => (
          <span key={u.id} className="notify-chip">
            {u.name}
            <button
              type="button"
              className="notify-chip-remove"
              aria-label={`No avisarle a ${u.name}`}
              onClick={() => {
                onChange(selected.filter((id) => id !== u.id));
              }}
            >
              <XIcon size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        {available.length > 0 && (
          <select
            className="notify-add"
            aria-label="Avisar también a"
            value=""
            onChange={(event) => {
              if (event.target.value !== '') onChange([...selected, event.target.value]);
            }}
          >
            <option value="">+ Avisar también a…</option>
            {available.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </fieldset>
  );
}
