import { useEffect, useRef, useState } from 'react';
import { rmsLevel } from '../lib/recording.ts';

const LEVEL_INTERVAL_MS = 80;

function microphoneError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'No se dio permiso para usar el micrófono.';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No se encontró un micrófono.';
  }
  return error instanceof Error ? error.message : 'No se pudo usar el micrófono.';
}

/**
 * Micrófono encendido mientras `enabled`: pide permiso al activarlo (así el
 * medidor muestra el nivel real antes de grabar y al empezar no hay otro
 * permiso) y lo libera al desactivarlo o al salir de la página.
 */
export function useMicrophone(enabled: boolean, onError: (message: string) => void) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [level, setLevel] = useState(0);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;

    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((mic) => {
        if (cancelled) {
          for (const track of mic.getTracks()) track.stop();
          return;
        }
        acquired = mic;
        setStream(mic);
        // Medidor de nivel: lee el audio sin modificarlo.
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(mic).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let last = 0;
        const tick = (time: number) => {
          if (time - last >= LEVEL_INTERVAL_MS) {
            last = time;
            analyser.getFloatTimeDomainData(samples);
            setLevel(rmsLevel(samples));
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      })
      .catch((error: unknown) => {
        if (!cancelled) onErrorRef.current(microphoneError(error));
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      void context?.close();
      if (acquired) for (const track of acquired.getTracks()) track.stop();
      setStream(null);
      setLevel(0);
    };
  }, [enabled]);

  return { stream, level };
}
