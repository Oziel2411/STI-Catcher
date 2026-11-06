import { mailStatusResponseSchema, mailTestResponseSchema } from '@sti-catcher/shared';
import type { MailStatusResponse } from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

/**
 * Avisos por mail (D-099, D-104): si hay servidor de correo y un botón para
 * mandarse un mail de prueba. La configuración está en el .env del servidor.
 */
export function MailCard() {
  const [status, setStatus] = useState<MailStatusResponse | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet('/api/mail', mailStatusResponseSchema, controller.signal)
      .then(setStatus)
      .catch(() => {
        // Sin respuesta: la tarjeta queda en "Consultando…".
      });
    return () => {
      controller.abort();
    };
  }, []);

  const sendTest = () => {
    setSending(true);
    setResult(null);
    apiPost('/api/mail/test', mailTestResponseSchema)
      .then(({ sentTo }) => {
        setResult({
          ok: true,
          message: `Mail de prueba enviado a ${sentTo}. Revisá la bandeja (y la de spam).`,
        });
      })
      .catch((error: unknown) => {
        setResult({ ok: false, message: errorMessage(error) });
      })
      .finally(() => {
        setSending(false);
      });
  };

  const ready = status !== null && status.configured;

  return (
    <div className="card">
      <h2>Aviso por mail</h2>
      <p className="muted small">
        Al grabar, descargar o convertir, cada uno elige a quién avisar cuando termine o falle. El
        mail de prueba te llega a vos.
      </p>
      {status === null ? (
        <p className="muted small">Consultando…</p>
      ) : !status.configured ? (
        <p className="small">
          No está configurado: falta el servidor de correo (SMTP_HOST y la casilla) en el .env.
        </p>
      ) : (
        <>
          <p className="stat">Activo</p>
          <p className="muted small">Desde {status.from}</p>
        </>
      )}
      <div className="row">
        <button
          type="button"
          className="button button-secondary"
          disabled={!ready || sending}
          onClick={sendTest}
        >
          {sending ? 'Enviando…' : 'Mandar mail de prueba'}
        </button>
      </div>
      {result && (
        <p className={`small ${result.ok ? '' : 'text-error'}`} role="status">
          {result.message}
        </p>
      )}
    </div>
  );
}
