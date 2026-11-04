import type { RECORDING_FPS } from '@sti-catcher/shared';
import { createContext, useContext, useEffect, useState } from 'react';
import type { UploaderState } from '../../api/chunk-uploader.ts';
import type { SourceKind } from '../../lib/recording.ts';

export type Fps = (typeof RECORDING_FPS)[number];

/** Lo que el navegador compartió (todavía no se graba). */
export type Preview = { stream: MediaStream; video: MediaStreamTrack };

export type RecorderPhase =
  | { kind: 'idle' }
  | { kind: 'choosing'; previous: Preview | null }
  | { kind: 'previewing'; preview: Preview }
  | { kind: 'starting'; preview: Preview }
  | { kind: 'recording'; preview: Preview; startedAt: number }
  | { kind: 'finishing' }
  | { kind: 'tracking'; jobId: string };

export type RecorderSettings = {
  sourceKind: SourceKind;
  fps: Fps;
  systemAudio: boolean;
  microphone: boolean;
  title: string;
};

export type Recorder = {
  settings: RecorderSettings;
  phase: RecorderPhase;
  upload: UploaderState;
  error: string | null;
  warning: string | null;
  mic: { stream: MediaStream | null; level: number };
  setSourceKind: (kind: SourceKind) => void;
  setSystemAudio: (value: boolean) => void;
  setMicrophone: (value: boolean) => void;
  setTitle: (value: string) => void;
  changeFps: (value: Fps) => void;
  chooseSource: () => Promise<void>;
  startRecording: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  /**
   * La página Grabar avisa que está abierta. Al cerrarla, una vista previa sin
   * grabar se deja de compartir (y se suelta el micrófono); una grabación sigue.
   */
  attachPage: () => () => void;
};

export const RecorderContext = createContext<Recorder | null>(null);

/** Estado de la grabación, que vive en el layout: sigue al cambiar de sección. */
export function useRecorder(): Recorder {
  const recorder = useContext(RecorderContext);
  if (!recorder) throw new Error('useRecorder necesita un RecorderProvider.');
  return recorder;
}

export const previewOf = (phase: RecorderPhase): Preview | null =>
  phase.kind === 'previewing' || phase.kind === 'starting' || phase.kind === 'recording'
    ? phase.preview
    : phase.kind === 'choosing'
      ? phase.previous
      : null;

export const stopPreview = (preview: Preview | null) => {
  if (preview) for (const track of preview.stream.getTracks()) track.stop();
};

/** Segundos desde `startedAt`, actualizados dos veces por segundo. null = sin reloj. */
export function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000);
}
