import { isActiveStatus, RECORDING_CHUNK_INTERVAL_MS, RECORDING_FPS } from '@sti-catcher/shared';
import type { Job } from '@sti-catcher/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChunkUploader } from '../../api/chunk-uploader.ts';
import type { UploaderState } from '../../api/chunk-uploader.ts';
import { chunkSender, createRecording, finishRecording } from '../../api/recordings.ts';
import { JobProgress } from '../../components/JobProgress.tsx';
import { useTrackedJob } from '../../hooks/useTrackedJob.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { defaultRecordingTitle, pickMimeType, recordingSupport } from '../../lib/recording.ts';
import type { RecordingSupport } from '../../lib/recording.ts';

type Fps = (typeof RECORDING_FPS)[number];

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
 * Grabación de pantalla (SPEC §6). El navegador graba con MediaRecorder y
 * manda un fragmento cada 2 s; el server los junta y al terminar los procesa
 * a MP4. Si el navegador se cierra a mitad, lo que llegó se procesa igual.
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

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'finishing' }
  | { kind: 'tracking'; jobId: string };

/** Todo lo que hay que cerrar al terminar: pistas, AudioContext, MediaRecorder. */
type Session = {
  recorder: MediaRecorder;
  uploader: ChunkUploader;
  recordingId: string;
  tracks: MediaStreamTrack[];
  audioContext: AudioContext | null;
};

const EMPTY_UPLOAD: UploaderState = { pending: 0, uploadedBytes: 0, retrying: false, error: null };

function Recorder() {
  const [fps, setFps] = useState<Fps>(30);
  const [systemAudio, setSystemAudio] = useState(true);
  const [microphone, setMicrophone] = useState(false);
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [upload, setUpload] = useState<UploaderState>(EMPTY_UPLOAD);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sessionRef = useRef<Session | null>(null);

  const trackedId = phase.kind === 'tracking' ? phase.jobId : null;
  const { job, connected } = useTrackedJob(trackedId);
  const busy =
    phase.kind === 'starting' || phase.kind === 'recording' || phase.kind === 'finishing';

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

  // Si se navega a otra sección, se corta la grabación (lo grabado se procesa igual).
  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (session && session.recorder.state !== 'inactive') session.recorder.stop();
    },
    [],
  );

  const releaseMedia = (session: Session) => {
    for (const track of session.tracks) track.stop();
    void session.audioContext?.close();
  };

  /** Después de `recorder.stop()`: esperar los últimos fragmentos y pedir el procesamiento. */
  const finish = async (session: Session) => {
    setPhase({ kind: 'finishing' });
    releaseMedia(session);
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

  const start = async () => {
    setError(null);
    setWarning(null);
    setUpload(EMPTY_UPLOAD);
    setPhase({ kind: 'starting' });
    const tracks: MediaStreamTrack[] = [];
    let audioContext: AudioContext | null = null;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: fps } },
        audio: systemAudio,
      });
      tracks.push(...display.getTracks());
      const mic = microphone
        ? await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          })
        : null;
      if (mic) tracks.push(...mic.getTracks());

      const [video] = display.getVideoTracks();
      if (!video) throw new Error('No se recibió video de la pantalla.');
      // Una sola pista de audio: si hay sistema y micrófono, se mezclan.
      const audioSources = [display, mic].filter(
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
      if (systemAudio && display.getAudioTracks().length === 0) {
        setWarning(
          'El navegador no compartió el sonido del sistema. En Chrome/Edge hay que tildar «Compartir audio» al elegir la pantalla o la pestaña.',
        );
      }

      const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
      if (mimeType === null) throw new Error('Este navegador no puede grabar en MP4 ni WebM.');

      const { recordingId } = await createRecording({
        mimeType,
        fps,
        title: title.trim() || defaultRecordingTitle(new Date()),
      });

      const stream = new MediaStream(audio ? [video, audio] : [video]);
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
      const session: Session = { recorder, uploader, recordingId, tracks, audioContext };
      sessionRef.current = session;

      recorder.ondataavailable = (event) => {
        uploader.push(event.data);
      };
      recorder.onstop = () => {
        void finish(session);
      };
      // «Dejar de compartir» en la barra del navegador corta la pista de video.
      video.addEventListener('ended', () => {
        if (recorder.state !== 'inactive') recorder.stop();
      });

      recorder.start(RECORDING_CHUNK_INTERVAL_MS);
      const startedAt = Date.now();
      setNow(startedAt);
      setPhase({ kind: 'recording', startedAt });
    } catch (e) {
      for (const track of tracks) track.stop();
      void audioContext?.close();
      setPhase({ kind: 'idle' });
      // Cerrar el selector de pantalla no es un error.
      if (e instanceof DOMException && e.name === 'NotAllowedError') {
        if (tracks.length > 0) setError('No se dio permiso para usar el micrófono.');
        return;
      }
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        setError('No se encontró un micrófono.');
        return;
      }
      setError(errorMessage(e));
    }
  };

  const stop = () => {
    const recorder = sessionRef.current?.recorder;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  const reset = () => {
    setPhase({ kind: 'idle' });
    setUpload(EMPTY_UPLOAD);
    setWarning(null);
  };

  return (
    <div className="card">
      <fieldset className="options" disabled={busy || phase.kind === 'tracking'}>
        <legend>Opciones</legend>
        <label className="field">
          <span>Título (opcional)</span>
          <input
            type="text"
            maxLength={200}
            placeholder={defaultRecordingTitle(new Date())}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
          />
        </label>
        <div className="row">
          {RECORDING_FPS.map((value) => (
            <label key={value} className="choice">
              <input
                type="radio"
                name="fps"
                checked={fps === value}
                onChange={() => {
                  setFps(value);
                }}
              />
              <span>
                <strong>{value} cuadros/s</strong>
                <span className="muted small">
                  {value === 30 ? ' — presentaciones y documentos' : ' — videos y movimiento'}
                </span>
              </span>
            </label>
          ))}
        </div>
        <label className="choice">
          <input
            type="checkbox"
            checked={systemAudio}
            onChange={(e) => {
              setSystemAudio(e.target.checked);
            }}
          />
          <span>
            Sonido del sistema o de la pestaña
            <span className="muted small"> — hay que tildar «Compartir audio» al elegir</span>
          </span>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={microphone}
            onChange={(e) => {
              setMicrophone(e.target.checked);
            }}
          />
          <span>Micrófono</span>
        </label>
      </fieldset>

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

      <div className="row">
        {phase.kind === 'recording' ? (
          <button type="button" className="button button-danger" onClick={stop}>
            Detener grabación
          </button>
        ) : phase.kind === 'tracking' ? (
          job !== null &&
          !isActiveStatus(job.status) && (
            <button type="button" className="button button-secondary" onClick={reset}>
              Nueva grabación
            </button>
          )
        ) : (
          <button type="button" className="button" onClick={() => void start()} disabled={busy}>
            {phase.kind === 'starting' ? 'Eligiendo pantalla…' : 'Elegir pantalla y grabar'}
          </button>
        )}
      </div>

      {trackedId !== null && job === null && <p className="muted small">Conectando…</p>}
      {job && (
        <JobProgress job={job} connected={connected} doneContent={<RecordingDone job={job} />} />
      )}
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
