import { NavCount } from '../../components/NavCount.tsx';
import { formatDuration } from '../../lib/format.ts';
import { useElapsedSeconds, useRecorder } from './recorder-context.ts';

/**
 * Junto a «Grabar pantalla» en la barra lateral: muestra que se está grabando
 * (y cuánto) desde cualquier sección, porque la grabación sigue al navegar.
 */
export function RecordingNavBadge({ processing }: { processing: number }) {
  const { phase } = useRecorder();
  const elapsed = useElapsedSeconds(phase.kind === 'recording' ? phase.startedAt : null);
  if (phase.kind === 'recording') {
    return (
      <span className="nav-rec" title="Grabando">
        <span className="recording-dot" aria-hidden="true" />
        <span className="visually-hidden">Grabando, </span>
        {formatDuration(elapsed)}
      </span>
    );
  }
  if (phase.kind === 'finishing') {
    return <span className="nav-rec nav-rec-muted">subiendo…</span>;
  }
  // Grabaciones de este navegador que se están procesando a MP4.
  return <NavCount value={processing} />;
}
