import { describe, expect, it } from 'vitest';
import {
  describeSource,
  displayMediaOptions,
  friendlyTrackLabel,
  pickMimeType,
  recordingSupport,
  rmsLevel,
  sourceKindFromSurface,
} from './recording.ts';

describe('pickMimeType', () => {
  it('prefiere MP4 H.264 + AAC, después WebM VP9/Opus, después WebM', () => {
    expect(pickMimeType(() => true)).toBe('video/mp4;codecs=avc1,mp4a.40.2');
    expect(pickMimeType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9,opus');
    expect(pickMimeType((t) => t === 'video/webm')).toBe('video/webm');
    expect(pickMimeType(() => false)).toBeNull();
  });
});

describe('recordingSupport', () => {
  const base = {
    isSecureContext: true,
    hasGetDisplayMedia: true,
    hasMediaRecorder: true,
    origin: 'https://sti.empresa.local',
  };

  it('HTTPS o localhost: se puede grabar', () => {
    expect(recordingSupport(base)).toEqual({ ok: true });
  });

  it('sin contexto seguro (http://<IP> desde otra PC): explica por qué', () => {
    expect(
      recordingSupport({ ...base, isSecureContext: false, origin: 'http://192.168.0.20:3000' }),
    ).toEqual({
      ok: false,
      reason: 'insecure',
      origin: 'http://192.168.0.20:3000',
    });
  });

  it('navegador sin getDisplayMedia o MediaRecorder', () => {
    expect(recordingSupport({ ...base, hasGetDisplayMedia: false })).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });
});

describe('fuente de la grabación', () => {
  it('reconoce lo que se eligió de verdad', () => {
    expect(sourceKindFromSurface('window')).toBe('window');
    expect(sourceKindFromSurface('application')).toBeNull();
    expect(sourceKindFromSurface(undefined)).toBeNull();
  });

  it('no muestra los identificadores internos de Chrome como nombre', () => {
    expect(friendlyTrackLabel('screen:0:0')).toBeNull();
    expect(friendlyTrackLabel('window:132456:0')).toBeNull();
    expect(friendlyTrackLabel('web-contents-media-stream://1:2')).toBeNull();
    expect(friendlyTrackLabel('  ')).toBeNull();
    expect(friendlyTrackLabel('Planilla de guardias — Excel')).toBe('Planilla de guardias — Excel');
  });

  it('arma el texto de la vista previa', () => {
    expect(
      describeSource({
        kind: 'window',
        label: 'Planilla de guardias — Excel',
        width: 1600,
        height: 900,
        hasAudio: false,
      }),
    ).toEqual({ title: 'Ventana · Planilla de guardias — Excel', meta: '1600x900 · sin sonido' });
    expect(
      describeSource({
        kind: 'monitor',
        label: 'screen:0:0',
        width: undefined,
        height: 0,
        hasAudio: true,
      }),
    ).toEqual({ title: 'Pantalla completa', meta: 'con sonido' });
  });

  it('pide al navegador el tipo elegido y excluye la propia pestaña', () => {
    expect(displayMediaOptions('browser', 60, true)).toMatchObject({
      video: { displaySurface: 'browser', frameRate: { ideal: 60 } },
      audio: true,
      selfBrowserSurface: 'exclude',
      systemAudio: 'include',
    });
    expect(displayMediaOptions('monitor', 30, false)).toMatchObject({
      audio: false,
      systemAudio: 'exclude',
    });
  });
});

describe('rmsLevel', () => {
  it('silencio = 0, señal fuerte satura en 1', () => {
    expect(rmsLevel([])).toBe(0);
    expect(rmsLevel(new Float32Array(128))).toBe(0);
    expect(rmsLevel(new Float32Array(128).fill(0.5))).toBe(1);
  });

  it('voz normal cae en la mitad de la barra', () => {
    expect(rmsLevel(new Float32Array(128).fill(0.1))).toBeCloseTo(0.4, 5);
  });
});
