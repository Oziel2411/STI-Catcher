import {
  AppWindowIcon,
  BrowserIcon,
  MicrophoneIcon,
  MonitorIcon,
  StopIcon,
  SwapIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { isActiveStatus, RECORDING_FPS } from '@sti-catcher/shared';
import type { Job } from '@sti-catcher/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { JobProgress } from '../../components/JobProgress.tsx';
import { useTrackedJob } from '../../hooks/useTrackedJob.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import {
  defaultRecordingTitle,
  describeSource,
  recordingSupport,
  SOURCE_KINDS,
} from '../../lib/recording.ts';
import type { RecordingSupport, SourceKind } from '../../lib/recording.ts';
import { previewOf, useElapsedSeconds, useRecorder } from './recorder-context.ts';
import type { Fps, Preview } from './recorder-context.ts';

const SOURCE_ICONS: Record<SourceKind, Icon> = {
  monitor: MonitorIcon,
  window: AppWindowIcon,
  browser: BrowserIcon,
};

const CHOOSE_LABELS: Record<SourceKind, string> = {
  monitor: 'Elegir pantalla…',
  window: 'Elegir ventana…',
  browser: 'Elegir pestaña…',
};

const FPS_LABELS: Record<Fps, string> = { 30: '30 · documentos', 60: '60 · movimiento' };

function detectSupport(): RecordingSupport {
  return recordingSupport({
    isSecureContext: window.isSecureContext,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no existe sin contexto seguro
    hasGetDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    hasMediaRecorder: typeof window.MediaRecorder === 'function',
    origin: window.location.origin,
  });
}

/**
 * Grabación de pantalla (SPEC §6). Primero se elige qué compartir y se ve en
 * vivo; después se graba. La grabación vive en `RecorderProvider` (layout):
 * esta página solo la muestra, así que se puede ir a otra sección sin cortarla.
 */
export function RecordingPage() {
  const [support] = useState(detectSupport);
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Grabar pantalla</h1>
          <p className="muted">
            Una pantalla, una ventana o una pestaña, con el sonido del sistema y el micrófono.
          </p>
        </div>
      </header>
      {support.ok ? <Recorder /> : <Unsupported support={support} />}
    </section>
  );
}

function Unsupported({ support }: { support: Exclude<RecordingSupport, { ok: true }> }) {
  if (support.reason === 'unsupported') {
    return (
      <div className="alert alert-error" role="alert">
        Este navegador no puede grabar la pantalla. Usá una versión actual de Chrome, Edge o Firefox
        en una computadora (no funciona en celulares).
      </div>
    );
  }
  return (
    <div className="alert alert-warn" role="alert">
      <p>
        <strong>Para grabar hace falta una conexión segura (HTTPS).</strong>
      </p>
      <p className="small">
        Estás entrando por <code>{support.origin}</code>. Los navegadores solo permiten capturar la
        pantalla en páginas HTTPS (o en <code>localhost</code>, desde la misma PC del servidor).
        Pedile a quien administra STI-Catcher la dirección HTTPS. Descargar y convertir funcionan
        igual por esta dirección.
      </p>
    </div>
  );
}

function Recorder() {
  const recorder = useRecorder();
  const { settings, phase, upload, error, warning, mic, attachPage } = recorder;
  const { sourceKind, fps, systemAudio, microphone, title } = settings;

  // Con la página abierta, el micrófono muestra su nivel; al irse, una vista
  // previa sin grabar se deja de compartir. Una grabación sigue (D-094).
  useEffect(() => attachPage(), [attachPage]);

  const preview = previewOf(phase);
  const trackedId = phase.kind === 'tracking' ? phase.jobId : null;
  const { job, connected } = useTrackedJob(trackedId);
  const recording = phase.kind === 'recording';
  const elapsed = useElapsedSeconds(phase.kind === 'recording' ? phase.startedAt : null);
  const locked =
    phase.kind === 'choosing' ||
    phase.kind === 'starting' ||
    recording ||
    phase.kind === 'finishing';

  const noSystemAudio =
    preview !== null && systemAudio && preview.stream.getAudioTracks().length === 0;

  return (
    <>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {warning && (
        <div className="alert alert-warn" role="status">
          {warning}
        </div>
      )}
      {noSystemAudio && phase.kind !== 'choosing' && (
        <div className="alert alert-warn" role="status">
          El navegador no compartió el sonido del sistema. En Chrome/Edge hay que tildar «Compartir
          audio» al elegir la pantalla o la pestaña: usá «Cambiar» para volver a elegir.
        </div>
      )}

      <div className="recorder">
        <div className="recorder-main">
          <div className="source-tiles" role="radiogroup" aria-label="Qué grabar">
            {SOURCE_KINDS.map(({ kind, title: sourceName, hint }) => {
              const TileIcon = SOURCE_ICONS[kind];
              return (
                <label key={kind} className="choice-card source-tile">
                  <input
                    type="radio"
                    name="source"
                    className="visually-hidden"
                    checked={sourceKind === kind}
                    disabled={locked}
                    onChange={() => {
                      recorder.setSourceKind(kind);
                    }}
                  />
                  <TileIcon size={20} aria-hidden="true" className="source-tile-icon" />
                  <span>
                    <span className="choice-card-title">{sourceName}</span>
                    <span className="choice-card-hint">{hint}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <SourcePreview
            preview={preview}
            sourceKind={sourceKind}
            recording={recording}
            choosing={phase.kind === 'choosing'}
            canChange={phase.kind === 'previewing'}
            disabled={phase.kind === 'finishing' || phase.kind === 'tracking'}
            onChoose={() => void recorder.chooseSource()}
          />

          {phase.kind === 'recording' && (
            <div className="recording-status" aria-live="polite">
              <span className="recording-dot" aria-hidden="true" />
              <strong>Grabando {formatDuration(elapsed)}</strong>
              <span className="muted small">
                {formatBytes(upload.uploadedBytes)} subidos
                {upload.pending > 2 && ` · ${String(upload.pending)} fragmentos esperando`}
                {upload.retrying && ' · problemas de red, reintentando…'}
              </span>
            </div>
          )}
          {phase.kind === 'finishing' && (
            <p className="muted small" aria-live="polite">
              Subiendo los últimos fragmentos…
              {upload.pending > 0 && ` (${String(upload.pending)} pendientes)`}
            </p>
          )}
          {phase.kind === 'previewing' && (
            <p className="muted small help-line">
              «Cambiar» vuelve a abrir el selector del navegador en la solapa del tipo elegido.
              Todavía no se está grabando.
            </p>
          )}

          {trackedId !== null && job === null && <p className="muted small">Conectando…</p>}
          {job && (
            <div className="card">
              <JobProgress
                job={job}
                connected={connected}
                doneContent={<RecordingDone job={job} />}
              />
              {!isActiveStatus(job.status) && (
                <button type="button" className="button button-secondary" onClick={recorder.reset}>
                  Nueva grabación
                </button>
              )}
            </div>
          )}
        </div>

        <div className="card recorder-options">
          <label className="field">
            <span>Título (opcional)</span>
            <input
              type="text"
              maxLength={200}
              placeholder={defaultRecordingTitle(new Date())}
              value={title}
              disabled={locked}
              onChange={(e) => {
                recorder.setTitle(e.target.value);
              }}
            />
          </label>

          <div className="field">
            <span id="fps-label">Cuadros por segundo</span>
            <div className="seg seg-block" role="radiogroup" aria-labelledby="fps-label">
              {RECORDING_FPS.map((value) => (
                <label key={value} className="seg-opt">
                  <input
                    type="radio"
                    name="fps"
                    checked={fps === value}
                    disabled={locked}
                    onChange={() => {
                      recorder.changeFps(value);
                    }}
                  />
                  {FPS_LABELS[value]}
                </label>
              ))}
            </div>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={systemAudio}
              disabled={locked}
              onChange={(e) => {
                recorder.setSystemAudio(e.target.checked);
              }}
            />
            <span>
              Sonido del sistema o de la pestaña
              <span className="check-hint">Hay que tildar «Compartir audio» al elegir.</span>
            </span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={microphone}
              disabled={locked}
              onChange={(e) => {
                recorder.setMicrophone(e.target.checked);
              }}
            />
            <span>Micrófono</span>
          </label>
          {microphone && (
            <div className="mic-meter" title="Nivel del micrófono">
              <MicrophoneIcon size={16} aria-hidden="true" />
              <div
                className="meter"
                role="meter"
                aria-label="Nivel del micrófono"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(mic.level * 100)}
              >
                <div className="meter-fill" style={{ width: `${String(mic.level * 100)}%` }} />
              </div>
            </div>
          )}

          {recording ? (
            <button
              type="button"
              className="button button-danger button-block"
              onClick={recorder.stop}
            >
              <StopIcon size={14} weight="fill" aria-hidden="true" />
              Detener grabación
            </button>
          ) : (
            <button
              type="button"
              className="button button-block"
              disabled={phase.kind !== 'previewing' || (microphone && mic.stream === null)}
              onClick={() => void recorder.startRecording()}
            >
              <span className="rec-dot" aria-hidden="true" />
              {phase.kind === 'starting' ? 'Empezando…' : 'Empezar a grabar'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function SourcePreview({
  preview,
  sourceKind,
  recording,
  choosing,
  canChange,
  disabled,
  onChoose,
}: {
  preview: Preview | null;
  sourceKind: SourceKind;
  recording: boolean;
  choosing: boolean;
  canChange: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = preview?.stream ?? null;
  }, [preview]);

  const KindIcon = SOURCE_ICONS[sourceKind];
  if (!preview) {
    return (
      <div className="preview">
        <div className="preview-empty">
          <KindIcon size={34} aria-hidden="true" />
          <span>Elegí qué compartir</span>
          <button
            type="button"
            className="button"
            onClick={onChoose}
            disabled={choosing || disabled}
          >
            {choosing ? 'Esperando al navegador…' : CHOOSE_LABELS[sourceKind]}
          </button>
        </div>
      </div>
    );
  }

  const settings = preview.video.getSettings();
  const { title, meta } = describeSource({
    kind: sourceKind,
    label: preview.video.label,
    width: settings.width,
    height: settings.height,
    hasAudio: preview.stream.getAudioTracks().length > 0,
  });
  return (
    <div className={`preview ${recording ? 'preview-recording' : ''}`}>
      <video ref={videoRef} autoPlay muted playsInline aria-label="Vista previa de lo compartido" />
      <div className="preview-bar">
        <KindIcon size={16} aria-hidden="true" className="preview-bar-icon" />
        <span className="preview-bar-title">{title}</span>
        <span className="preview-bar-meta">{meta}</span>
        <button
          type="button"
          className="button button-secondary preview-change"
          onClick={onChoose}
          disabled={!canChange}
        >
          <SwapIcon size={14} aria-hidden="true" />
          {choosing ? 'Esperando…' : 'Cambiar'}
        </button>
      </div>
    </div>
  );
}

function RecordingDone({ job }: { job: Job }) {
  const fileUrl = `/api/jobs/${job.id}/file`;
  const details = [
    formatDuration(job.durationSeconds),
    job.resolution,
    job.sizeBytes !== null ? formatBytes(job.sizeBytes) : null,
  ].filter((part): part is string => part !== null && part !== '—');
  return (
    <>
      <div className="player">
        <video controls preload="metadata" src={`${fileUrl}?inline=1`} />
      </div>
      <div className="row">
        <a className="button" href={fileUrl} download>
          Descargar MP4
        </a>
        <Link className="button button-secondary" to={`/convertir?origen=${job.id}`}>
          Convertir
        </Link>
        <Link className="button button-secondary" to="/historial">
          Ver en el historial
        </Link>
        {details.length > 0 && <span className="muted small">{details.join(' · ')}</span>}
      </div>
    </>
  );
}
