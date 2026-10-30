import {
  AppWindowIcon,
  BrowserIcon,
  MicrophoneIcon,
  MonitorIcon,
  StopIcon,
  SwapIcon,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { isActiveStatus, RECORDING_CHUNK_INTERVAL_MS, RECORDING_FPS } from '@sti-catcher/shared';
import type { Job } from '@sti-catcher/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChunkUploader } from '../../api/chunk-uploader.ts';
import type { UploaderState } from '../../api/chunk-uploader.ts';
import { chunkSender, createRecording, finishRecording } from '../../api/recordings.ts';
import { JobProgress } from '../../components/JobProgress.tsx';
import { useMicrophone } from '../../hooks/useMicrophone.ts';
import { useTrackedJob } from '../../hooks/useTrackedJob.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import {
  defaultRecordingTitle,
  describeSource,
  displayMediaOptions,
  pickMimeType,
  recordingSupport,
  SOURCE_KINDS,
  sourceKindFromSurface,
} from '../../lib/recording.ts';
import type { RecordingSupport, SourceKind } from '../../lib/recording.ts';

type Fps = (typeof RECORDING_FPS)[number];

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

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

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
 * vivo; después se graba. El navegador graba con MediaRecorder y manda un
 * fragmento cada 2 s; el server los junta y al terminar los procesa a MP4.
 * Si el navegador se cierra a mitad, lo que llegó se procesa igual.
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

/** Lo que el navegador compartió (todavía no se graba). */
type Preview = { stream: MediaStream; video: MediaStreamTrack };

type Phase =
  | { kind: 'idle' }
  | { kind: 'choosing'; previous: Preview | null }
  | { kind: 'previewing'; preview: Preview }
  | { kind: 'starting'; preview: Preview }
  | { kind: 'recording'; preview: Preview; startedAt: number }
  | { kind: 'finishing' }
  | { kind: 'tracking'; jobId: string };

/** Lo que hay que cerrar al terminar la grabación. */
type Session = {
  recorder: MediaRecorder;
  uploader: ChunkUploader;
  recordingId: string;
  preview: Preview;
  audioContext: AudioContext | null;
};

const EMPTY_UPLOAD: UploaderState = { pending: 0, uploadedBytes: 0, retrying: false, error: null };

const stopPreview = (preview: Preview | null) => {
  if (preview) for (const track of preview.stream.getTracks()) track.stop();
};

const previewOf = (phase: Phase): Preview | null =>
  phase.kind === 'previewing' || phase.kind === 'starting' || phase.kind === 'recording'
    ? phase.preview
    : phase.kind === 'choosing'
      ? phase.previous
      : null;

function Recorder() {
  const [sourceKind, setSourceKind] = useState<SourceKind>('monitor');
  const [fps, setFps] = useState<Fps>(30);
  const [systemAudio, setSystemAudio] = useState(true);
  const [microphone, setMicrophone] = useState(false);
  const [title, setTitle] = useState('');
  const [phase, setPhaseState] = useState<Phase>({ kind: 'idle' });
  const [upload, setUpload] = useState<UploaderState>(EMPTY_UPLOAD);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Copia de la fase para los eventos del navegador (track "ended", desmontar).
  const phaseRef = useRef<Phase>(phase);
  const sessionRef = useRef<Session | null>(null);

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const onMicError = useCallback((message: string) => {
    setError(message);
    setMicrophone(false);
  }, []);
  // El micrófono se suelta al terminar: no queda encendido mientras se procesa.
  const mic = useMicrophone(
    microphone && phase.kind !== 'finishing' && phase.kind !== 'tracking',
    onMicError,
  );

  const preview = previewOf(phase);
  const trackedId = phase.kind === 'tracking' ? phase.jobId : null;
  const { job, connected } = useTrackedJob(trackedId);
  const recording = phase.kind === 'recording';
  const locked =
    phase.kind === 'choosing' ||
    phase.kind === 'starting' ||
    recording ||
    phase.kind === 'finishing';

  // Reloj de la grabación.
  useEffect(() => {
    if (phase.kind !== 'recording') return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [phase.kind]);

  // Cerrar la pestaña mientras se graba o se suben los últimos fragmentos pierde el final.
  useEffect(() => {
    if (phase.kind !== 'recording' && phase.kind !== 'finishing') return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [phase.kind]);

  // Al ir a otra sección: se corta la grabación (lo grabado se procesa igual)
  // o se deja de compartir la vista previa.
  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (session && session.recorder.state !== 'inactive') session.recorder.stop();
      else stopPreview(previewOf(phaseRef.current));
    },
    [],
  );

  /** «Dejar de compartir» en la barra del navegador corta la pista de video. */
  const onSourceEnded = (ended: Preview) => {
    const current = phaseRef.current;
    if (current.kind === 'recording' && current.preview === ended) {
      const recorder = sessionRef.current?.recorder;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } else if (current.kind === 'previewing' && current.preview === ended) {
      stopPreview(ended);
      setPhase({ kind: 'idle' });
    }
  };

  /** Abre el selector del navegador. Si se cancela, queda lo que se estaba viendo. */
  const chooseSource = async () => {
    const previous = previewOf(phaseRef.current);
    setError(null);
    setPhase({ kind: 'choosing', previous });
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaOptions(sourceKind, fps, systemAudio),
      );
      const [video] = stream.getVideoTracks();
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error('No se recibió video de la pantalla.');
      }
      stopPreview(previous);
      const next: Preview = { stream, video };
      // El tipo pedido es una sugerencia: se muestra lo que se eligió de verdad.
      const actual = sourceKindFromSurface(video.getSettings().displaySurface);
      if (actual) setSourceKind(actual);
      video.addEventListener('ended', () => {
        onSourceEnded(next);
      });
      setPhase({ kind: 'previewing', preview: next });
    } catch (e) {
      setPhase(previous ? { kind: 'previewing', preview: previous } : { kind: 'idle' });
      // Cerrar el selector sin elegir no es un error.
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) setError(errorMessage(e));
    }
  };

  /** Después de `recorder.stop()`: esperar los últimos fragmentos y pedir el procesamiento. */
  const finish = async (session: Session) => {
    setPhase({ kind: 'finishing' });
    stopPreview(session.preview);
    void session.audioContext?.close();
    let uploadFailed: string | null = null;
    try {
      await session.uploader.drain();
    } catch (e) {
      uploadFailed = errorMessage(e);
    }
    try {
      const { jobId } = await finishRecording(session.recordingId);
      if (uploadFailed !== null) {
        setWarning(
          `No se pudo subir el final de la grabación (${uploadFailed}). Se guarda lo que llegó.`,
        );
      }
      setPhase({ kind: 'tracking', jobId });
    } catch (e) {
      setError(uploadFailed ?? errorMessage(e));
      setPhase({ kind: 'idle' });
    } finally {
      sessionRef.current = null;
    }
  };

  const startRecording = async (current: Preview) => {
    setError(null);
    setWarning(null);
    setUpload(EMPTY_UPLOAD);
    setPhase({ kind: 'starting', preview: current });
    let audioContext: AudioContext | null = null;
    try {
      // Una sola pista de audio: si hay sistema y micrófono, se mezclan.
      const audioSources = [
        systemAudio ? current.stream : null,
        microphone ? mic.stream : null,
      ].filter(
        (stream): stream is MediaStream => stream !== null && stream.getAudioTracks().length > 0,
      );
      let audio: MediaStreamTrack | undefined;
      if (audioSources.length === 1) {
        audio = audioSources[0]?.getAudioTracks()[0];
      } else if (audioSources.length > 1) {
        audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
        for (const source of audioSources) {
          audioContext.createMediaStreamSource(source).connect(destination);
        }
        audio = destination.stream.getAudioTracks()[0];
      }

      const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
      if (mimeType === null) throw new Error('Este navegador no puede grabar en MP4 ni WebM.');

      const { recordingId } = await createRecording({
        mimeType,
        fps,
        title: title.trim() || defaultRecordingTitle(new Date()),
      });

      const stream = new MediaStream(audio ? [current.video, audio] : [current.video]);
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: fps === 60 ? 8_000_000 : 5_000_000,
        audioBitsPerSecond: 160_000,
      });
      const uploader = new ChunkUploader(chunkSender(recordingId), {
        onChange: (state) => {
          setUpload(state);
          // Error definitivo (sin disco, sesión cerrada…): no tiene sentido seguir grabando.
          if (state.error !== null && recorder.state !== 'inactive') recorder.stop();
        },
      });
      const session: Session = { recorder, uploader, recordingId, preview: current, audioContext };
      sessionRef.current = session;

      recorder.ondataavailable = (event) => {
        uploader.push(event.data);
      };
      recorder.onstop = () => {
        void finish(session);
      };
      recorder.start(RECORDING_CHUNK_INTERVAL_MS);
      const startedAt = Date.now();
      setNow(startedAt);
      setPhase({ kind: 'recording', preview: current, startedAt });
    } catch (e) {
      void audioContext?.close();
      setPhase({ kind: 'previewing', preview: current });
      setError(errorMessage(e));
    }
  };

  const stop = () => {
    const recorder = sessionRef.current?.recorder;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  const changeFps = (value: Fps) => {
    setFps(value);
    // Si ya se está viendo la fuente, se ajusta sin volver a elegirla.
    preview?.video.applyConstraints({ frameRate: { ideal: value } }).catch(() => {
      // Algunos navegadores no lo permiten: se aplica la próxima vez que se elija.
    });
  };

  const reset = () => {
    setPhase({ kind: 'idle' });
    setUpload(EMPTY_UPLOAD);
    setWarning(null);
    setError(null);
  };

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
                      setSourceKind(kind);
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
            onChoose={() => void chooseSource()}
          />

          {phase.kind === 'recording' && (
            <div className="recording-status" aria-live="polite">
              <span className="recording-dot" aria-hidden="true" />
              <strong>Grabando {formatDuration((now - phase.startedAt) / 1000)}</strong>
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
                <button type="button" className="button button-secondary" onClick={reset}>
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
                setTitle(e.target.value);
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
                      changeFps(value);
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
                setSystemAudio(e.target.checked);
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
                setError(null);
                setMicrophone(e.target.checked);
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
            <button type="button" className="button button-danger button-block" onClick={stop}>
              <StopIcon size={14} weight="fill" aria-hidden="true" />
              Detener grabación
            </button>
          ) : (
            <button
              type="button"
              className="button button-block"
              disabled={phase.kind !== 'previewing' || (microphone && mic.stream === null)}
              onClick={() => {
                if (phase.kind === 'previewing') void startRecording(phase.preview);
              }}
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
