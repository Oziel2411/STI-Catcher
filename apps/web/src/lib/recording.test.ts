import { describe, expect, it } from 'vitest';
import { pickMimeType, recordingSupport } from './recording.ts';

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
