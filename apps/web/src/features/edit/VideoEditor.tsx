import {
  CaretDoubleLeftIcon,
  CaretDoubleRightIcon,
  CaretLeftIcon,
  CaretRightIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
} from '@phosphor-icons/react';
import { editResponseSchema, editSourceResponseSchema, isActiveStatus } from '@sti-catcher/shared';
import type { EditOutput, EditPrecision, EditSourceResponse, Job } from '@sti-catcher/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Link } from 'react-router';
import { apiGet, apiPost } from '../../api/client.ts';
import { subscribeToJobsEvents } from '../../api/events.ts';
import { JobProgress } from '../../components/JobProgress.tsx';
import {
  clampTime,
  cutAt,
  DEFAULT_FPS,
  editorKey,
  editProblem,
  endHere,
  formatTimecode,
  initialPieces,
  keptDuration,
  moveCut,
  nearestCut,
  removeCut,
  segmentsFor,
  startHere,
  toggleKeep,
} from '../../lib/edit.ts';
import type { Piece } from '../../lib/edit.ts';
import { formatBytes } from '../../lib/format.ts';
import { applyJobEvent } from '../../lib/jobs.ts';
import { NotifyPicker } from '../auth/NotifyPicker.tsx';
import { useNotifyChoice } from '../auth/use-notify-choice.ts';
import './editor.css';

type Props = {
  sourceJobId: string;
  /** Si está, se muestra «Cerrar» (p. ej. para volver al reproductor de la grabación). */
  onClose?: () => void;
};

const pct = (t: number, duration: number) => `${String((t / duration) * 100)}%`;

/**
 * Recortar y dividir (D-112): línea de tiempo con cortes sobre el video.
 * Cada tramo queda o se saca; el resultado es uno o varios trabajos nuevos
 * (el original no se toca).
 */
export function VideoEditor({ sourceJobId, onClose }: Props) {
  const [source, setSource] = useState<EditSourceResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // Quien cambia de video le pone otra `key`: acá no hace falta limpiar el anterior.
    const controller = new AbortController();
    apiGet(
      `/api/edit/sources/${encodeURIComponent(sourceJobId)}`,
      editSourceResponseSchema,
      controller.signal,
    )
      .then(setSource)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : 'No se pudo abrir el video.');
        }
      });
    return () => {
      controller.abort();
    };
  }, [sourceJobId]);

  if (loadError !== null) return <p className="alert alert-error">{loadError}</p>;
  if (source === null) return <p className="muted small">Abriendo el video…</p>;
  return <Editor source={source} onClose={onClose} />;
}

function Editor({ source, onClose }: { source: EditSourceResponse; onClose?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(source.media.durationSeconds ?? 0);
  const [pieces, setPieces] = useState<Piece[]>(() => initialPieces(duration));
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [output, setOutput] = useState<EditOutput>('single');
  const [precision, setPrecision] = useState<EditPrecision>('exact');
  const [notify, setNotify] = useNotifyChoice('edit', false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string[]>([]);
  const fps = source.media.frameRate ?? DEFAULT_FPS;
  const job = source.job;
  const fileUrl = `/api/jobs/${job.id}/file?inline=1`;

  // Sin duración de ffprobe se usa la del navegador, cuando la sabe.
  const onLoadedMetadata = () => {
    const video = videoRef.current;
    if (video === null || duration > 0 || !Number.isFinite(video.duration)) return;
    setDuration(video.duration);
    setPieces(initialPieces(video.duration));
  };

  // Mientras reproduce, el cursor sigue al video cuadro a cuadro (timeupdate va a 4 por segundo).
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      setTime(videoRef.current?.currentTime ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playing]);

  const seek = useCallback(
    (t: number) => {
      const video = videoRef.current;
      const next = clampTime(t, duration);
      if (video !== null) video.currentTime = next;
      setTime(next);
    },
    [duration],
  );

  const togglePlay = () => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const action = editorKey(event.key, event.shiftKey);
    if (action === null) return;
    event.preventDefault();
    const now = videoRef.current?.currentTime ?? time;
    switch (action.kind) {
      case 'toggle-play':
        togglePlay();
        break;
      case 'seek':
        seek(now + action.seconds);
        break;
      case 'frame':
        videoRef.current?.pause();
        seek(now + action.frames / fps);
        break;
      case 'cut':
        setPieces((list) => cutAt(list, now));
        break;
      case 'start-here':
        setPieces((list) => startHere(list, now));
        break;
      case 'end-here':
        setPieces((list) => endHere(list, now));
        break;
      case 'remove-cut': {
        const index = nearestCut(pieces, now);
        if (index !== null) setPieces((list) => removeCut(list, index));
        break;
      }
    }
  };

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clampTime(((clientX - rect.left) / rect.width) * duration, duration);
  };

  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).dataset.cut !== undefined) return;
    seek(timeAt(event.clientX));
  };

  const onHandlePointerDown = (index: number) => (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (e: globalThis.PointerEvent) => {
      const t = timeAt(e.clientX);
      setPieces((list) => moveCut(list, index, t));
      seek(t);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const segments = segmentsFor(pieces, output);
  const problem = duration > 0 ? editProblem(pieces, output) : 'El video todavía no cargó.';
  const files = output === 'split' ? segments.length : 1;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { jobIds } = await apiPost('/api/jobs/edit', editResponseSchema, {
        sourceJobId: job.id,
        segments,
        output,
        precision,
        notify,
      });
      setCreated((list) => [...list, ...jobIds]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear el trabajo.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="editor">
      <div
        className="editor-stage"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label="Editor de video. Teclas: espacio reproduce, flechas 1 segundo, coma y punto un cuadro, C corta, I y O marcan inicio y fin, Supr saca el corte más cercano."
      >
        <div className="player">
          <video
            ref={videoRef}
            src={fileUrl}
            preload="metadata"
            onClick={togglePlay}
            onLoadedMetadata={onLoadedMetadata}
            onPlay={() => {
              setPlaying(true);
            }}
            onPause={() => {
              setPlaying(false);
              setTime(videoRef.current?.currentTime ?? 0);
            }}
            onSeeked={() => {
              setTime(videoRef.current?.currentTime ?? 0);
            }}
          />
        </div>

        <div className="editor-transport">
          <button
            type="button"
            className="button button-secondary button-icon"
            title="10 s atrás (Shift + ←)"
            onClick={() => {
              seek(time - 10);
            }}
          >
            <CaretDoubleLeftIcon size={16} aria-label="10 segundos atrás" />
          </button>
          <button
            type="button"
            className="button button-secondary button-icon"
            title="Un cuadro atrás (,)"
            onClick={() => {
              videoRef.current?.pause();
              seek(time - 1 / fps);
            }}
          >
            <CaretLeftIcon size={16} aria-label="Un cuadro atrás" />
          </button>
          <button
            type="button"
            className="button button-secondary button-icon"
            title="Reproducir o pausar (espacio)"
            onClick={togglePlay}
          >
            {playing ? (
              <PauseIcon size={16} aria-label="Pausar" />
            ) : (
              <PlayIcon size={16} aria-label="Reproducir" />
            )}
          </button>
          <button
            type="button"
            className="button button-secondary button-icon"
            title="Un cuadro adelante (.)"
            onClick={() => {
              videoRef.current?.pause();
              seek(time + 1 / fps);
            }}
          >
            <CaretRightIcon size={16} aria-label="Un cuadro adelante" />
          </button>
          <button
            type="button"
            className="button button-secondary button-icon"
            title="10 s adelante (Shift + →)"
            onClick={() => {
              seek(time + 10);
            }}
          >
            <CaretDoubleRightIcon size={16} aria-label="10 segundos adelante" />
          </button>
          <span className="editor-time">
            {formatTimecode(time)} / {formatTimecode(duration)}
          </span>
          <span className="editor-spacer" />
          <button
            type="button"
            className="button button-secondary"
            title="El video empieza acá (I)"
            onClick={() => {
              setPieces((list) => startHere(list, time));
            }}
          >
            Empieza acá
          </button>
          <button
            type="button"
            className="button button-secondary"
            title="El video termina acá (O)"
            onClick={() => {
              setPieces((list) => endHere(list, time));
            }}
          >
            Termina acá
          </button>
          <button
            type="button"
            className="button button-secondary"
            title="Cortar en este punto (C)"
            onClick={() => {
              setPieces((list) => cutAt(list, time));
            }}
          >
            <ScissorsIcon size={16} aria-hidden="true" />
            Cortar acá
          </button>
        </div>

        {duration > 0 && (
          <div
            ref={trackRef}
            className="editor-track"
            role="slider"
            aria-label="Línea de tiempo"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(time)}
            aria-valuetext={formatTimecode(time)}
            onPointerDown={onTrackPointerDown}
          >
            {pieces.map((piece, i) => (
              <div
                key={`${String(piece.start)}-${String(i)}`}
                className={`editor-piece ${piece.keep ? '' : 'editor-piece-removed'}`}
                style={{
                  left: pct(piece.start, duration),
                  width: pct(piece.end - piece.start, duration),
                }}
                title={`${formatTimecode(piece.start)} – ${formatTimecode(piece.end)}${piece.keep ? '' : ' (se saca)'}`}
              />
            ))}
            {pieces.slice(0, -1).map((piece, i) => (
              <button
                key={`cut-${String(i)}`}
                type="button"
                data-cut=""
                className="editor-cut"
                style={{ left: pct(piece.end, duration) }}
                aria-label={`Corte en ${formatTimecode(piece.end)}: arrastrá para moverlo`}
                onPointerDown={onHandlePointerDown(i)}
              />
            ))}
            <div className="editor-playhead" style={{ left: pct(time, duration) }} />
          </div>
        )}
        <p className="muted small">
          Teclas: espacio reproduce · ← → 1 s (Shift: 10 s) · <kbd>,</kbd> <kbd>.</kbd> un cuadro ·{' '}
          <kbd>C</kbd> corta · <kbd>I</kbd> <kbd>O</kbd> inicio y fin · <kbd>Supr</kbd> saca el
          corte más cercano. Arrastrá los cortes para moverlos.
        </p>
      </div>

      <div className="card editor-options">
        <table className="editor-pieces">
          <thead>
            <tr>
              <th>Queda</th>
              <th>Tramo</th>
              <th>Duración</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pieces.map((piece, i) => (
              <tr key={`${String(piece.start)}-${String(i)}`} className={piece.keep ? '' : 'muted'}>
                <td>
                  <input
                    type="checkbox"
                    checked={piece.keep}
                    aria-label={`Dejar el tramo ${String(i + 1)}`}
                    onChange={() => {
                      setPieces((list) => toggleKeep(list, i));
                    }}
                  />
                </td>
                <td>
                  {formatTimecode(piece.start)} – {formatTimecode(piece.end)}
                </td>
                <td>{formatTimecode(piece.end - piece.start)}</td>
                <td>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => {
                      seek(piece.start);
                    }}
                  >
                    Ir
                  </button>
                  {i < pieces.length - 1 && (
                    <button
                      type="button"
                      className="button button-ghost"
                      title="Juntar con el siguiente"
                      onClick={() => {
                        setPieces((list) => removeCut(list, i));
                      }}
                    >
                      Sacar corte
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="field">
          <span id="edit-output-label">Resultado</span>
          <div className="seg seg-block" role="radiogroup" aria-labelledby="edit-output-label">
            <label className="seg-opt">
              <input
                type="radio"
                name="edit-output"
                checked={output === 'single'}
                onChange={() => {
                  setOutput('single');
                }}
              />
              Un solo video
            </label>
            <label className="seg-opt">
              <input
                type="radio"
                name="edit-output"
                checked={output === 'split'}
                onChange={() => {
                  setOutput('split');
                }}
              />
              Un video por tramo
            </label>
          </div>
        </div>

        <div className="field">
          <span id="edit-precision-label">Precisión del corte</span>
          <div className="seg seg-block" role="radiogroup" aria-labelledby="edit-precision-label">
            <label className="seg-opt">
              <input
                type="radio"
                name="edit-precision"
                checked={precision === 'exact'}
                onChange={() => {
                  setPrecision('exact');
                }}
              />
              Exacta
            </label>
            <label className="seg-opt">
              <input
                type="radio"
                name="edit-precision"
                checked={precision === 'fast'}
                onChange={() => {
                  setPrecision('fast');
                }}
              />
              Rápida
            </label>
          </div>
          <span className="muted small">
            {precision === 'exact'
              ? 'Corta en el cuadro marcado. Vuelve a codificar el video, así que tarda un poco más.'
              : 'No vuelve a codificar: es casi instantáneo, pero cada tramo arranca en el cuadro clave anterior y puede empezar unos segundos antes.'}
          </span>
        </div>

        <NotifyPicker
          value={notify}
          onChange={setNotify}
          what="el recorte"
          hint="Si dividís en varios videos, llega un solo mail cuando terminan todos."
        />

        {error !== null && <p className="small text-error">{error}</p>}
        <div className="row">
          <button
            type="button"
            className="button"
            disabled={problem !== null || submitting}
            onClick={() => void submit()}
          >
            <ScissorsIcon size={16} aria-hidden="true" />
            {submitting
              ? 'Creando…'
              : files > 1
                ? `Crear ${String(files)} videos`
                : 'Crear el video recortado'}
          </button>
          {onClose && (
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cerrar
            </button>
          )}
          <span className="muted small">
            {problem ?? `Queda: ${formatTimecode(keptDuration(pieces))}`}
          </span>
        </div>
        <p className="muted small">El original no se modifica: el resultado es un trabajo nuevo.</p>
      </div>

      {created.length > 0 && <CreatedJobs jobIds={created} />}
    </div>
  );
}

/** Los trabajos creados, con su progreso por un solo stream SSE. */
function CreatedJobs({ jobIds }: { jobIds: string[] }) {
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [connected, setConnected] = useState(true);
  const key = jobIds.join(',');
  const allFinished =
    jobIds.length > 0 &&
    jobIds.every((id) => {
      const job = jobs[id];
      return job !== undefined && !isActiveStatus(job.status);
    });

  useEffect(() => {
    if (allFinished) return;
    return subscribeToJobsEvents(key.split(','), {
      onEvent: (event) => {
        const id = event.type === 'job.updated' ? event.job.id : event.jobId;
        setJobs((current) => {
          const next = applyJobEvent(current[id] ?? null, event);
          return next === null || next === current[id] ? current : { ...current, [id]: next };
        });
      },
      onConnectionChange: setConnected,
    });
  }, [key, allFinished]);

  return (
    <div className="card editor-results">
      <h2>Videos creados</h2>
      {jobIds.map((id) => {
        const job = jobs[id];
        if (job === undefined) {
          return (
            <p key={id} className="muted small">
              Esperando al servidor…
            </p>
          );
        }
        return (
          <JobProgress
            key={id}
            job={job}
            connected={connected}
            doneContent={
              <div className="row">
                <a className="button" href={`/api/jobs/${job.id}/file`} download>
                  Descargar MP4
                </a>
                <Link className="button button-secondary" to="/historial">
                  Ver en el historial
                </Link>
                {job.sizeBytes !== null && (
                  <span className="muted small">{formatBytes(job.sizeBytes)}</span>
                )}
              </div>
            }
          />
        );
      })}
    </div>
  );
}
