import { mailStatusResponseSchema, mailTestResponseSchema } from '@sti-catcher/shared';
import type { MailStatusResponse } from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

/**
 * Aviso por mail al terminar una grabación (D-099): si está configurado y un
 * botón para mandar un mail de prueba. La configuración está en el .env del
 * servidor (las direcciones no se muestran).
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
          message:
            sentTo === 1
              ? 'Mail de prueba enviado al destinatario. Revisá la bandeja (y la de spam).'
              : `Mail de prueba enviado a los ${String(sentTo)} destinatarios. Revisá las bandejas (y spam).`,
        });
      })
      .catch((error: unknown) => {
        setResult({ ok: false, message: errorMessage(error) });
      })
      .finally(() => {
        setSending(false);
      });
  };

  const ready = status !== null && status.configured && status.recipients > 0;

  return (
    <div className="card">
      <h2>Aviso por mail</h2>
      <p className="muted small">
        Cuando termina una grabación se manda un mail a las direcciones configuradas en el servidor
        (MAIL_TO).
      </p>
      {status === null ? (
        <p className="muted small">Consultando…</p>
      ) : !status.configured ? (
        <p className="small">
          No está configurado: falta el servidor de correo (SMTP_HOST y la casilla) en el .env.
        </p>
      ) : (
        <>
          <p className="stat">
            {status.recipients === 0
              ? 'Sin destinatarios'
              : `Activo · ${String(status.recipients)} ${status.recipients === 1 ? 'destinatario' : 'destinatarios'}`}
          </p>
          <p className="muted small">
            Desde {status.from}
            {status.recipients === 0 && '. Completá MAIL_TO en el .env y reiniciá el servidor.'}
          </p>
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
