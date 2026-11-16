import { ArrowDownIcon, FilesIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { formatBytes } from '../lib/format.ts';

/** Zona para soltar o elegir archivos (Convertir y Comprimir, mockup 2f). */
export function Dropzone({
  dragFiles,
  maxUploadBytes,
  compact,
  onPick,
}: {
  dragFiles: number | null;
  maxUploadBytes: number;
  compact: boolean;
  onPick: () => void;
}) {
  const dragging = dragFiles !== null;
  return (
    <div
      className={`dropzone ${dragging ? 'dropzone-active' : ''} ${compact ? 'dropzone-compact' : ''}`}
    >
      {dragging ? (
        <>
          <ArrowDownIcon size={26} aria-hidden="true" className="dropzone-icon" />
          <span className="dropzone-title">
            Soltá para agregar {dragFiles === 1 ? 'el archivo' : `${String(dragFiles)} archivos`}
          </span>
          <span className="small muted">
            Máximo {formatBytes(maxUploadBytes)} por archivo: los más grandes no se suben.
          </span>
        </>
      ) : (
        <>
          <FilesIcon size={26} aria-hidden="true" className="dropzone-icon" />
          <span className="dropzone-title">Arrastrá uno o varios archivos acá</span>
          <span className="small muted">
            O elegí del <Link to="/historial">historial</Link>. Máximo {formatBytes(maxUploadBytes)}{' '}
            por archivo.
          </span>
          <button type="button" className="button" onClick={onPick}>
            Elegir archivos
          </button>
        </>
      )}
    </div>
  );
}
