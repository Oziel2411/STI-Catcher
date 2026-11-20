import { ScissorsIcon } from '@phosphor-icons/react';
import { Link, useSearchParams } from 'react-router';
import { PageTitle } from '../../components/PageTitle.tsx';
import { parseOrigin } from '../../lib/convert-batch.ts';
import { VideoEditor } from './VideoEditor.tsx';

/**
 * Recortar y dividir cualquier video del historial (D-112): `/editar?origen=<id>`.
 * No está en la barra de secciones: se llega desde el historial o desde una
 * grabación terminada.
 */
export function EditPage() {
  const [params] = useSearchParams();
  const [origin] = parseOrigin(params.get('origen'));

  return (
    <section className="page">
      <header className="page-header">
        <PageTitle icon={ScissorsIcon} title="Recortar o dividir">
          Sacá el principio, el final o un tramo del medio, o partí el video en varios.
        </PageTitle>
      </header>
      {origin === undefined ? (
        <div className="card">
          <p>
            Elegí un video desde el <Link to="/historial">historial</Link> (menú «…», «Recortar o
            dividir») o desde una grabación terminada.
          </p>
        </div>
      ) : (
        <VideoEditor key={origin} sourceJobId={origin} />
      )}
    </section>
  );
}
