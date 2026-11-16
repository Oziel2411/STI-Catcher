import { describe, expect, it } from 'vitest';
import {
  COMPRESSION_PRESET_IDS,
  COMPRESSION_PRESETS,
  compressionOptionsSchema,
  TARGET_SIZE_SHORTCUTS,
} from './compression.ts';
import {
  estimateCompressedSize,
  outputVideo,
  planTargetSize,
  retryVideoKbps,
  TARGET_MARGIN,
  videoKbpsForTarget,
} from './compression-size.ts';
import type { CompressionSource } from './compression-size.ts';

const MB = 1024 * 1024;
const parse = (input: unknown) => compressionOptionsSchema.parse(input);

/** 1080p a 60 cuadros, 10 minutos (una grabación de pantalla típica). */
const screen1080p60: CompressionSource = {
  width: 1920,
  height: 1080,
  frameRate: 60,
  durationSeconds: 600,
  hasAudio: true,
};

describe('presets de compresión', () => {
  it('cada preset declara su id, una calidad RF válida y un audio de la lista', () => {
    for (const id of COMPRESSION_PRESET_IDS) {
      const preset = COMPRESSION_PRESETS[id];
      expect(preset.id).toBe(id);
      expect(preset.quality).toBeGreaterThanOrEqual(18);
      expect(preset.quality).toBeLessThanOrEqual(30);
    }
  });

  it('H.265 solo en los presets de archivo', () => {
    const hevc = COMPRESSION_PRESET_IDS.filter((id) => COMPRESSION_PRESETS[id].codec === 'hevc');
    expect(hevc).toEqual(['archive-1080p', 'archive-original']);
  });

  it('los atajos de tamaño quedan por debajo del límite de cada servicio', () => {
    expect(TARGET_SIZE_SHORTCUTS.map((s) => s.megabytes)).toEqual([24, 95, 250]);
  });
});

describe('compressionOptionsSchema', () => {
  it('por defecto: calidad constante, resolución y audio del preset', () => {
    expect(parse({ preset: 'fast-720p' })).toEqual({
      preset: 'fast-720p',
      target: { mode: 'quality' },
      maxHeight: null,
      audioKbps: null,
    });
  });

  it('tamaño objetivo: acepta decimales dentro de los límites', () => {
    expect(
      parse({ preset: 'share-720p', target: { mode: 'size', megabytes: 24.5 } }).target,
    ).toEqual({ mode: 'size', megabytes: 24.5 });
  });

  it('rechaza tamaños fuera de los límites, audio fuera de la lista y presets inventados', () => {
    const bad = [
      { preset: 'share-720p', target: { mode: 'size', megabytes: 1 } },
      { preset: 'share-720p', target: { mode: 'size', megabytes: 10_000 } },
      { preset: 'share-720p', target: { mode: 'size' } },
      { preset: 'share-720p', audioKbps: 100 },
      { preset: 'share-720p', target: { mode: 'bitrate', kbps: 500 } },
      { preset: 'x264 -crf 0' },
    ];
    for (const input of bad) expect(compressionOptionsSchema.safeParse(input).success).toBe(false);
  });
});

describe('outputVideo', () => {
  it('baja al tope del preset con ancho par y limita los cuadros', () => {
    expect(outputVideo(screen1080p60, parse({ preset: 'fast-720p' }))).toEqual({
      width: 1280,
      height: 720,
      fpsCap: 30,
      fpsForMath: 30,
      scaled: true,
    });
  });

  it('nunca sube: un 480p con el preset 1080p queda en 480p', () => {
    const small = { width: 854, height: 480, frameRate: 30, durationSeconds: 60, hasAudio: true };
    expect(outputVideo(small, parse({ preset: 'fast-1080p' }))).toMatchObject({
      width: 854,
      height: 480,
      fpsCap: null,
      scaled: false,
    });
  });

  it('la altura elegida baja más que el preset, nunca menos', () => {
    expect(outputVideo(screen1080p60, parse({ preset: 'fast-1080p', maxHeight: 480 })).height).toBe(
      480,
    );
    expect(outputVideo(screen1080p60, parse({ preset: 'fast-720p', maxHeight: 1080 })).height).toBe(
      720,
    );
  });

  it('ancho par con proporciones raras (vertical de celular)', () => {
    const vertical = {
      width: 1080,
      height: 1920,
      frameRate: 30,
      durationSeconds: 30,
      hasAudio: true,
    };
    const out = outputVideo(vertical, parse({ preset: 'fast-720p' }));
    expect(out.height).toBe(720);
    expect(out.width % 2).toBe(0);
    expect(out.width).toBe(406);
  });

  it('sin cuadros informados (WebM de MediaRecorder): aplica el tope del preset', () => {
    const webm = { ...screen1080p60, frameRate: null };
    expect(outputVideo(webm, parse({ preset: 'screen' })).fpsCap).toBe(30);
    expect(outputVideo(webm, parse({ preset: 'archive-original' }))).toMatchObject({
      fpsCap: null,
      fpsForMath: 30,
    });
  });

  it('29,97 cuadros con tope 30: no se toca', () => {
    const ntsc = { ...screen1080p60, frameRate: 30000 / 1001 };
    expect(outputVideo(ntsc, parse({ preset: 'fast-1080p' })).fpsCap).toBeNull();
  });
});

describe('tamaño objetivo', () => {
  it('bitrate de video = total con margen y contenedor, menos el audio', () => {
    // 24 MB en 10 min: 335,5 kbps totales × 0,9 × 0,99 − 96 de audio.
    expect(
      videoKbpsForTarget({
        targetBytes: 24 * MB,
        durationSeconds: 600,
        audioKbps: 96,
        margin: TARGET_MARGIN.gpu,
      }),
    ).toBe(202);
  });

  it('10 min a 24 MB en 720p no alcanza: sugiere 480p o menos', () => {
    const options = parse({ preset: 'share-720p', target: { mode: 'size', megabytes: 24 } });
    const plan = planTargetSize(screen1080p60, options, TARGET_MARGIN.gpu);
    expect(plan).toEqual({ ok: false, reason: 'too-small', suggestedHeight: 360 });
  });

  it('con más tamaño, alcanza y devuelve el bitrate', () => {
    const options = parse({ preset: 'share-720p', target: { mode: 'size', megabytes: 95 } });
    const plan = planTargetSize(screen1080p60, options, TARGET_MARGIN.cpu);
    expect(plan.ok && plan.videoKbps).toBeGreaterThan(1000);
  });

  it('si ni a la resolución más chica alcanza, no sugiere ninguna', () => {
    const long = { ...screen1080p60, durationSeconds: 10 * 3600 };
    const options = parse({ preset: 'share-720p', target: { mode: 'size', megabytes: 5 } });
    expect(planTargetSize(long, options, TARGET_MARGIN.gpu)).toEqual({
      ok: false,
      reason: 'too-small',
      suggestedHeight: null,
    });
  });

  it('sin audio, todo el tamaño va al video (un caso que con audio no alcanzaría)', () => {
    // 10 min a 24 MB en 360p: 202 kbps con audio de 96; sin audio, 298.
    const options = parse({
      preset: 'share-720p',
      target: { mode: 'size', megabytes: 24 },
      maxHeight: 480,
    });
    expect(planTargetSize(screen1080p60, options, TARGET_MARGIN.gpu).ok).toBe(false);
    expect(
      planTargetSize({ ...screen1080p60, hasAudio: false }, options, TARGET_MARGIN.gpu),
    ).toEqual({ ok: true, videoKbps: 298 });
  });

  it('sin duración no hay cuenta posible', () => {
    const options = parse({ preset: 'share-720p', target: { mode: 'size', megabytes: 24 } });
    expect(
      planTargetSize({ ...screen1080p60, durationSeconds: null }, options, TARGET_MARGIN.gpu),
    ).toEqual({ ok: false, reason: 'no-duration' });
  });

  it('reintento: baja en proporción a lo que se pasó, con 5 % extra', () => {
    // Pesó 110 % del objetivo con 900 + 96 kbps → (996 / 1,1 × 0,95) − 96.
    expect(
      retryVideoKbps({ previousVideoKbps: 900, audioKbps: 96, actualBytes: 110, targetBytes: 100 }),
    ).toBe(764);
  });
});

describe('estimateCompressedSize', () => {
  it('tamaño objetivo: entre el margen de la GPU y lo pedido', () => {
    const options = parse({ preset: 'share-720p', target: { mode: 'size', megabytes: 100 } });
    expect(estimateCompressedSize(screen1080p60, options)).toEqual({
      minBytes: Math.round(90 * MB),
      maxBytes: 100 * MB,
    });
  });

  it('calidad constante: un rango, más chico a menor resolución y con H.265', () => {
    const at = (preset: string) => estimateCompressedSize(screen1080p60, parse({ preset }));
    const fast1080 = at('fast-1080p');
    const fast720 = at('fast-720p');
    const archive1080 = at('archive-1080p');
    expect(fast1080 && fast720 && archive1080).toBeTruthy();
    if (!fast1080 || !fast720 || !archive1080) return;
    expect(fast1080.minBytes).toBeLessThan(fast1080.maxBytes);
    expect(fast720.maxBytes).toBeLessThan(fast1080.maxBytes);
    // archive-1080p no limita los cuadros (60) pero es H.265 con RF 24.
    expect(archive1080.maxBytes).toBeLessThan(fast1080.maxBytes * 2);
  });

  it('sin duración: no hay estimación', () => {
    expect(
      estimateCompressedSize(
        { ...screen1080p60, durationSeconds: null },
        parse({ preset: 'screen' }),
      ),
    ).toBeNull();
  });
});
