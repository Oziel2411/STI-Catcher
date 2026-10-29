import { describe, expect, it } from 'vitest';
import { conversionRequestSchema } from '../schemas/conversion.ts';
import { availablePresets, CONVERSION_PRESET_IDS, CONVERSION_PRESETS } from './conversion.ts';

describe('availablePresets', () => {
  it('video con audio (p. ej. un .mov): todo', () => {
    expect(availablePresets({ hasVideo: true, hasAudio: true })).toEqual([
      ...CONVERSION_PRESET_IDS,
    ]);
  });

  it('solo audio: ninguna salida de video ni GIF (criterio de la Fase 5)', () => {
    expect(availablePresets({ hasVideo: false, hasAudio: true })).toEqual(['mp3', 'm4a', 'wav']);
  });

  it('video sin audio: sin salidas de audio', () => {
    expect(availablePresets({ hasVideo: true, hasAudio: false })).toEqual([
      'mp4',
      'webm',
      'mkv',
      'mov',
      'avi',
      'gif',
    ]);
  });

  it('cada preset declara una extensión simple y coherente con su id', () => {
    for (const id of CONVERSION_PRESET_IDS) {
      expect(CONVERSION_PRESETS[id].id).toBe(id);
      expect(CONVERSION_PRESETS[id].extension).toMatch(/^[a-z0-9]{2,4}$/);
    }
  });
});

describe('conversionRequestSchema', () => {
  const sourceJobId = '00000000-0000-4000-8000-00000000000a';

  it('rechaza presets fuera de la lista (no hay argumentos libres)', () => {
    expect(conversionRequestSchema.safeParse({ sourceJobId, preset: 'flv' }).success).toBe(false);
    expect(
      conversionRequestSchema.safeParse({ sourceJobId, preset: 'mp4', args: ['-i', 'x'] }).data,
    ).not.toHaveProperty('args');
  });

  it('GIF: el fin tiene que ser posterior al inicio', () => {
    const result = conversionRequestSchema.safeParse({
      sourceJobId,
      preset: 'gif',
      gif: { startSeconds: 5, endSeconds: 5, fps: 10, width: 480 },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/posterior/);
  });
});
