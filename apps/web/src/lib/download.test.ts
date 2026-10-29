import type { ProbeResponse } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import {
  codecNotices,
  codecsLabel,
  defaultHeight,
  defaultMode,
  resolutionLabel,
} from './download.ts';

/** Igual a lo que devuelve el server para Big Buck Bunny (fixture real). */
const bigBuckBunny: ProbeResponse = {
  url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  title: 'Big Buck Bunny',
  site: 'Youtube',
  uploader: 'Blender',
  thumbnailUrl: null,
  durationSeconds: 635,
  isLive: false,
  hasVideo: true,
  hasAudio: true,
  resolutions: [
    { height: 2160, codecs: ['vp9', 'av1'] },
    { height: 1440, codecs: ['vp9', 'av1'] },
    { height: 1080, codecs: ['h264', 'vp9', 'av1'] },
    { height: 720, codecs: ['h264', 'vp9', 'av1'] },
    { height: 144, codecs: ['h264', 'vp9', 'av1'] },
  ],
  maxH264Height: 1080,
};

/** Un video sin H.264 en ninguna resolución. */
const onlyVp9: ProbeResponse = {
  ...bigBuckBunny,
  resolutions: [
    { height: 1080, codecs: ['vp9'] },
    { height: 480, codecs: ['vp9'] },
  ],
  maxH264Height: null,
};

describe('etiquetas', () => {
  it('codecsLabel y resolutionLabel', () => {
    expect(codecsLabel(['vp9', 'av1'])).toBe('VP9/AV1');
    expect(resolutionLabel({ height: 1080, codecs: ['h264', 'vp9'] })).toBe('1080p');
    expect(resolutionLabel({ height: 2160, codecs: ['vp9', 'av1'] })).toBe('2160p · solo VP9/AV1');
  });
});

describe('defaultHeight', () => {
  it('la mayor en H.264, como mucho 1080p', () => {
    expect(defaultHeight(bigBuckBunny)).toBe(1080);
    expect(
      defaultHeight({
        ...bigBuckBunny,
        resolutions: [
          { height: 240, codecs: ['h264', 'av1'] },
          { height: 144, codecs: ['h264'] },
        ],
        maxH264Height: 240,
      }),
    ).toBe(240);
  });

  it('sin H.264: la mayor hasta 1080p', () => {
    expect(defaultHeight(onlyVp9)).toBe(1080);
  });

  it('sin resoluciones informadas: null ("la mejor disponible")', () => {
    expect(defaultHeight({ ...bigBuckBunny, resolutions: [], maxH264Height: null })).toBeNull();
  });
});

describe('defaultMode', () => {
  it('compatibilidad máxima si hay H.264; recodificar si no', () => {
    expect(defaultMode(bigBuckBunny)).toBe('compat');
    expect(defaultMode(onlyVp9)).toBe('recode');
  });
});

describe('codecNotices', () => {
  it('compat en 1080p con H.264: sin avisos', () => {
    expect(codecNotices(bigBuckBunny, 1080, 'compat')).toEqual([]);
  });

  it('compat en 2160p: avisa que se baja 1080p en H.264 (el caso del criterio)', () => {
    expect(codecNotices(bigBuckBunny, 2160, 'compat')).toEqual([
      { kind: 'compat-downgrade', requested: 2160, h264Height: 1080, codecs: ['vp9', 'av1'] },
    ]);
  });

  it('compat con "la mejor disponible" toma la mayor resolución', () => {
    expect(codecNotices(bigBuckBunny, null, 'compat')[0]?.kind).toBe('compat-downgrade');
  });

  it('compat sin ninguna H.264: imposible', () => {
    expect(codecNotices(onlyVp9, 1080, 'compat')).toEqual([
      { kind: 'compat-impossible', requested: 1080 },
    ]);
  });

  it('quality en 2160p: avisa que queda en VP9/AV1; en 1080p no', () => {
    expect(codecNotices(bigBuckBunny, 2160, 'quality')).toEqual([
      { kind: 'quality-codec', codecs: ['vp9', 'av1'] },
    ]);
    expect(codecNotices(bigBuckBunny, 1080, 'quality')).toEqual([]);
  });

  it('recode: siempre avisa que es lento', () => {
    expect(codecNotices(bigBuckBunny, 720, 'recode')).toEqual([{ kind: 'recode-slow' }]);
  });

  it('solo audio: sin avisos de video', () => {
    expect(codecNotices({ ...bigBuckBunny, hasVideo: false }, null, 'compat')).toEqual([]);
  });
});
