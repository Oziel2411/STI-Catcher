import { RECORDING_CHUNK_INTERVAL_MS } from '@sti-catcher/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChunkUploader } from '../../api/chunk-uploader.ts';
import type { UploaderState } from '../../api/chunk-uploader.ts';
import { chunkSender, createRecording, finishRecording } from '../../api/recordings.ts';
import { useMicrophone } from '../../hooks/useMicrophone.ts';
import {
  DEFAULT_SCHEDULE,
  formatClock,
  plannedStart,
  plannedStop,
  scheduleProblems,
} from '../../lib/recording-schedule.ts';
import type { RecordingSchedule } from '../../lib/recording-schedule.ts';
import {
  defaultRecordingTitle,
  displayMediaOptions,
  pickMimeType,
  sourceKindFromSurface,
} from '../../lib/recording.ts';
import type { SourceKind } from '../../lib/recording.ts';
import { keepScreenAwake, startBackgroundClock } from './background-clock.ts';
import { previewOf, RecorderContext, stopPreview } from './recorder-context.ts';
import type {
  Fps,
  Preview,
  Recorder,
  RecorderPhase,
  RecorderSettings,
} from './recorder-context.ts';

/** Lo que hay que cerrar al terminar la grabación. */
type Session = {
  recorder: MediaRecorder;
  uploader: ChunkUploader;
  recordingId: string;
  preview: Preview;
  audioContext: AudioContext | null;
};

const EMPTY_UPLOAD: UploaderState = { pending: 0, uploadedBytes: 0, retrying: false, error: null };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

/**
 * Grabación de pantalla (SPEC §6), montada en el layout: la grabación sigue
 * aunque se vaya a Descargar, Convertir, etc. (D-094). La página Grabar solo
 * muestra este estado y sus controles.
 *
 * El navegador graba con MediaRecorder y manda un fragmento cada 2 s; el
 * server los junta y al terminar los procesa a MP4. Si el navegador se cierra
 * a mitad, lo que llegó se procesa igual.
 */
export function RecorderProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<RecorderSettings>({
    sourceKind: 'monitor',
    fps: 30,
    systemAudio: true,
    microphone: false,
    title: '',
    schedule: DEFAULT_SCHEDULE,
  });
  const [phase, setPhaseState] = useState<RecorderPhase>({ kind: 'idle' });
  const [upload, setUpload] = useState<UploaderState>(EMPTY_UPLOAD);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pageOpen, setPageOpen] = useState(false);
  // Copias para los eventos del navegador (track "ended", selector que vuelve tarde).
  const phaseRef = useRef<RecorderPhase>(phase);
  const pageOpenRef = useRef(false);
  const sessionRef = useRef<Session | null>(null);

  const setPhase = useCallback((next: RecorderPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const patchSettings = (patch: Partial<RecorderSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  };

  const onMicError = useCallback((message: string) => {
    setError(message);
    setSettings((current) => ({ ...current, microphone: false }));
  }, []);
  // El micrófono se usa con la página abierta (medidor), mientras se graba o
  // se espera la hora de inicio, y se suelta al terminar.
  const grabbing =
    phase.kind === 'scheduled' || phase.kind === 'starting' || phase.kind === 'recording';
  const mic = useMicrophone(
    settings.microphone &&
      (pageOpen || grabbing) &&
      phase.kind !== 'finishing' &&
      phase.kind !== 'tracking',
    onMicError,
  );

  // Cerrar la pestaña mientras se graba (o se espera para grabar) pierde la grabación.
  useEffect(() => {
    if (phase.kind !== 'recording' && phase.kind !== 'finishing' && phase.kind !== 'scheduled') {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [phase.kind]);

  // Si se desmonta todo (no pasa al cambiar de sección), se corta lo que haya.
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
    } else if (current.kind === 'scheduled' && current.preview === ended) {
      stopPreview(ended);
      setPhase({ kind: 'idle' });
      setError('Se dejó de compartir la pantalla: se canceló la grabación programada.');
    }
  };

  const attachPage = useCallback(() => {
    pageOpenRef.current = true;
    setPageOpen(true);
    return () => {
      pageOpenRef.current = false;
      setPageOpen(false);
      // Una vista previa sin grabar no queda compartida en segundo plano.
      const current = phaseRef.current;
      if (current.kind === 'previewing') {
        stopPreview(current.preview);
        setPhase({ kind: 'idle' });
      }
    };
  }, [setPhase]);

  /** Abre el selector del navegador. Si se cancela, queda lo que se estaba viendo. */
  const chooseSource = async () => {
    const previous = previewOf(phaseRef.current);
    setError(null);
    setPhase({ kind: 'choosing', previous });
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaOptions(settings.sourceKind, settings.fps, settings.systemAudio),
      );
      const [video] = stream.getVideoTracks();
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error('No se recibió video de la pantalla.');
      }
      stopPreview(previous);
      // Se fue de la página mientras elegía: no se deja compartiendo sin que se vea.
      if (!pageOpenRef.current) {
        for (const track of stream.getTracks()) track.stop();
        setPhase({ kind: 'idle' });
        return;
      }
      const next: Preview = { stream, video };
      // El tipo pedido es una sugerencia: se muestra lo que se eligió de verdad.
      const actual = sourceKindFromSurface(video.getSettings().displaySurface);
      if (actual) patchSettings({ sourceKind: actual });
      video.addEventListener('ended', () => {
        onSourceEnded(next);
      });
      setPhase({ kind: 'previewing', preview: next });
    } catch (e) {
      const keep = previous && pageOpenRef.current;
      if (previous && !keep) stopPreview(previous);
      setPhase(keep ? { kind: 'previewing', preview: previous } : { kind: 'idle' });
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

  const startRecording = async () => {
    const current = phaseRef.current;
    if (current.kind !== 'previewing' && current.kind !== 'scheduled') return;
    const { preview } = current;
    const { fps, systemAudio, microphone, title, schedule } = settings;
    // Al empezar a mano solo importa el corte (el inicio programado ya pasó o no hay).
    const problems = scheduleProblems({ ...schedule, startMode: 'now' }, new Date());
    if (problems.length > 0) {
      setPhase({ kind: 'previewing', preview });
      setError(problems.join(' '));
      return;
    }
    setError(null);
    setWarning(null);
    setNotice(null);
    setUpload(EMPTY_UPLOAD);
    setPhase({ kind: 'starting', preview });
    let audioContext: AudioContext | null = null;
    try {
      // Una sola pista de audio: si hay sistema y micrófono, se mezclan.
      const audioSources = [
        systemAudio ? preview.stream : null,
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

      const stream = new MediaStream(audio ? [preview.video, audio] : [preview.video]);
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
      const session: Session = { recorder, uploader, recordingId, preview, audioContext };
      sessionRef.current = session;

      recorder.ondataavailable = (event) => {
        uploader.push(event.data);
      };
      recorder.onstop = () => {
        void finish(session);
      };
      recorder.start(RECORDING_CHUNK_INTERVAL_MS);
      const startedAt = Date.now();
      setPhase({
        kind: 'recording',
        preview,
        startedAt,
        stopAt: plannedStop(schedule, startedAt),
      });
    } catch (e) {
      void audioContext?.close();
      setPhase({ kind: 'previewing', preview });
      setError(errorMessage(e));
    }
  };

  const stop = () => {
    const recorder = sessionRef.current?.recorder;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  /** Con la vista previa abierta, queda esperando la hora de inicio. */
  const scheduleStart = () => {
    const current = phaseRef.current;
    if (current.kind !== 'previewing') return;
    const now = new Date();
    const problems = scheduleProblems(settings.schedule, now);
    const startAt = plannedStart(settings.schedule, now);
    if (problems.length > 0 || startAt === null) {
      setError(problems.join(' ') || 'Indicá a qué hora empieza.');
      return;
    }
    setError(null);
    setNotice(null);
    setPhase({ kind: 'scheduled', preview: current.preview, startAt });
  };

  const cancelSchedule = () => {
    const current = phaseRef.current;
    if (current.kind === 'scheduled') setPhase({ kind: 'previewing', preview: current.preview });
  };

  // Reloj de lo programado: arranca a la hora o corta a la hora. Lee el estado
  // por refs porque el tic viene de un Worker, fuera del ciclo de React.
  const tickRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    tickRef.current = () => {
      const current = phaseRef.current;
      const now = Date.now();
      if (current.kind === 'scheduled' && now >= current.startAt) {
        setNotice('La grabación programada empezó sola.');
        void startRecording();
      } else if (current.kind === 'recording' && current.stopAt !== null && now >= current.stopAt) {
        setNotice(`Se detuvo automáticamente a las ${formatClock(current.stopAt)}.`);
        stop();
      }
    };
  });
  const timed = phase.kind === 'scheduled' || (phase.kind === 'recording' && phase.stopAt !== null);
  useEffect(() => {
    if (!timed) return;
    return startBackgroundClock(() => {
      tickRef.current();
    });
  }, [timed]);

  // Que no se apague la pantalla mientras se espera o se graba.
  const awake = phase.kind === 'scheduled' || phase.kind === 'recording';
  useEffect(() => {
    if (!awake) return;
    return keepScreenAwake();
  }, [awake]);

  const changeFps = (value: Fps) => {
    patchSettings({ fps: value });
    // Si ya se está viendo la fuente, se ajusta sin volver a elegirla.
    previewOf(phase)
      ?.video.applyConstraints({ frameRate: { ideal: value } })
      .catch(() => {
        // Algunos navegadores no lo permiten: se aplica la próxima vez que se elija.
      });
  };

  const reset = () => {
    setPhase({ kind: 'idle' });
    setUpload(EMPTY_UPLOAD);
    setWarning(null);
    setError(null);
    setNotice(null);
  };

  const value: Recorder = {
    settings,
    phase,
    upload,
    error,
    warning,
    notice,
    mic,
    setSourceKind: (kind: SourceKind) => {
      patchSettings({ sourceKind: kind });
    },
    setSystemAudio: (systemAudio) => {
      patchSettings({ systemAudio });
    },
    setMicrophone: (microphone) => {
      setError(null);
      patchSettings({ microphone });
    },
    setTitle: (title) => {
      patchSettings({ title });
    },
    changeFps,
    setSchedule: (patch: Partial<RecordingSchedule>) => {
      setSettings((current) => ({ ...current, schedule: { ...current.schedule, ...patch } }));
    },
    scheduleStart,
    cancelSchedule,
    chooseSource,
    startRecording,
    stop,
    reset,
    attachPage,
  };

  return <RecorderContext value={value}>{children}</RecorderContext>;
}
