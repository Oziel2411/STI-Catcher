import type { GifLimits, SourceMedia } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import {
  defaultGif,
  defaultPreset,
  gifFpsOptions,
  gifProblems,
  gifWidthOptions,
  scaleOptions,
} from './convert.ts';

const limits: GifLimits = {
  maxSeconds: 30,
  maxFps: 15,
  maxWidth: 800,
  defaultFps: 10,
  defaultWidth: 480,
};
const mov: SourceMedia = {
  hasVideo: true,
  hasAudio: true,
  durationSeconds: 75.4,
  width: 1920,
  height: 1080,
  videoCodec: 'hevc',
  audioCodec: 'aac',
};

describe('defaultPreset', () => {
  it('MP4 si hay video; MP3 si es solo audio', () => {
    expect(defaultPreset(['mp4', 'mp3'])).toBe('mp4');
    expect(defaultPreset(['mp3', 'm4a', 'wav'])).toBe('mp3');
    expect(defaultPreset([])).toBeNull();
  });
});

describe('scaleOptions', () => {
  it('solo alturas menores que la original', () => {
    expect(scaleOptions(1080)).toEqual([720, 480, 360, 240]);
    expect(scaleOptions(null)).toEqual([]);
  });
});

describe('GIF', () => {
  it('por defecto: desde 0, hasta el tope de duración, 10 fps, 480 px', () => {
    expect(defaultGif(mov, limits)).toEqual({
      startSeconds: 0,
      endSeconds: 30,
      fps: 10,
      width: 480,
    });
    expect(defaultGif({ ...mov, durationSeconds: 12 }, limits).endSeconds).toBe(12);
  });

  it('no ofrece más FPS ni más ancho que los topes (ni que el video)', () => {
    expect(gifFpsOptions(limits)).toEqual([5, 8, 10, 12, 15]);
    expect(gifWidthOptions(limits, 1920).at(-1)).toBe(800);
    expect(gifWidthOptions(limits, 400).at(-1)).toBe(400);
  });

  it('detecta un fragmento demasiado largo o fuera del video', () => {
    expect(
      gifProblems({ startSeconds: 0, endSeconds: 30, fps: 10, width: 480 }, mov, limits),
    ).toEqual([]);
    expect(
      gifProblems({ startSeconds: 0, endSeconds: 40, fps: 10, width: 480 }, mov, limits),
    ).toEqual(['El GIF puede durar como máximo 30 s.']);
    expect(
      gifProblems({ startSeconds: 70, endSeconds: 80, fps: 10, width: 480 }, mov, limits)[0],
    ).toMatch(/dura 75,4 s/);
    expect(
      gifProblems({ startSeconds: 5, endSeconds: 5, fps: 10, width: 480 }, mov, limits),
    ).toContain('El fin tiene que ser posterior al inicio.');
  });
});
