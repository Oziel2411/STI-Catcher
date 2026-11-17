import {
  NETWORK_CA_CERT_PATH,
  NETWORK_CA_INSTALLER_PATH,
  networkCaResponseSchema,
} from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client.ts';
import { AuthCard } from './LoginPage.tsx';
import './auth.css';

type Availability = 'loading' | 'available' | 'missing';

/**
 * Certificado de la red (D-110), sin sesión. La primera vez el navegador
 * avisa que la conexión no es privada: se entra por «Avanzado → Continuar»,
 * se descarga el instalador y, desde ahí, el aviso no vuelve.
 */
export function CertificatePage() {
  const [availability, setAvailability] = useState<Availability>('loading');

  useEffect(() => {
    const controller = new AbortController();
    apiGet('/api/ca', networkCaResponseSchema, controller.signal)
      .then((response) => {
        setAvailability(response.available ? 'available' : 'missing');
      })
      .catch(() => {
        if (!controller.signal.aborted) setAvailability('missing');
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <AuthCard title="Certificado de la red">
      <p className="muted small login-help">
        Se instala una sola vez en cada PC. Sin él, el navegador avisa que la conexión no es privada
        y no deja grabar la pantalla.
      </p>
      {availability === 'missing' && (
        <p className="alert alert-error" role="alert">
          El servidor no tiene el certificado de la red. Avisale a Sistemas.
        </p>
      )}
      {availability === 'available' && (
        <>
          <ol className="cert-steps">
            <li>
              Descargá el instalador. Si el navegador pregunta si querés conservarlo, elegí{' '}
              <strong>Conservar</strong>.
            </li>
            <li>
              Abrilo y aceptá el aviso de Windows: pide permiso de administrador. Si Windows dice
              que protegió el equipo, tocá{' '}
              <strong>Más información → Ejecutar de todas formas</strong>.
            </li>
            <li>Cuando diga «Listo», cerrá el navegador del todo y volvé a abrir STI-Catcher.</li>
          </ol>
          <a className="button button-block" href={NETWORK_CA_INSTALLER_PATH} download>
            Descargar el instalador
          </a>
          <p className="muted small login-help">
            ¿Preferís hacerlo a mano? Descargá{' '}
            <a href={NETWORK_CA_CERT_PATH} download>
              el certificado
            </a>
            , abrilo y elegí <strong>Instalar certificado → Equipo local →</strong> almacén{' '}
            <strong>Entidades de certificación raíz de confianza</strong>.
          </p>
        </>
      )}
      <a className="login-link" href="/">
        Volver a ingresar
      </a>
    </AuthCard>
  );
}
