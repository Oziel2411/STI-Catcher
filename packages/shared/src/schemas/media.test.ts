import { describe, expect, it } from 'vitest';
import { downloadRequestSchema, followUpDownloadFormat, probeRequestSchema } from './media.ts';

describe('probeRequestSchema', () => {
  it('acepta http y https, y recorta espacios', () => {
    expect(probeRequestSchema.parse({ url: '  https://www.youtube.com/watch?v=x  ' }).url).toBe(
      'https://www.youtube.com/watch?v=x',
    );
    expect(probeRequestSchema.safeParse({ url: 'http://example.com/v' }).success).toBe(true);
  });

  it.each([
    'file:///C:/Windows/win.ini',
    'ftp://example.com/video.mp4',
    'javascript:alert(1)',
    '-o C:\\evil',
    'no es un link',
    '',
  ])('rechaza %j', (url) => {
    expect(probeRequestSchema.safeParse({ url }).success).toBe(false);
  });

  it('da un mensaje en español', () => {
    const result = probeRequestSchema.safeParse({ url: 'ftp://x.com' });
    expect(result.error?.issues[0]?.message).toMatch(/http:\/\/ o https:\/\//);
  });
});

describe('downloadRequestSchema', () => {
  it('por defecto: MP4, mejor resolución, modo compatibilidad', () => {
    expect(downloadRequestSchema.parse({ url: 'https://youtu.be/x' })).toEqual({
      url: 'https://youtu.be/x',
      format: 'mp4',
      maxHeight: null,
      videoMode: 'compat',
      title: null,
      then: null,
      notify: [],
    });
  });

  it('rechaza formatos y modos desconocidos', () => {
    expect(downloadRequestSchema.safeParse({ url: 'https://a.com', format: 'exe' }).success).toBe(
      false,
    );
    expect(
      downloadRequestSchema.safeParse({ url: 'https://a.com', videoMode: 'turbo' }).success,
    ).toBe(false);
  });
});

describe('then (conversión encadenada)', () => {
  const parse = (then: unknown) => downloadRequestSchema.safeParse({ url: 'https://a.com', then });

  it('acepta un preset con altura por defecto null', () => {
    const result = parse({ preset: 'webm' });
    expect(result.success && result.data.then).toEqual({ preset: 'webm', maxHeight: null });
  });

  it('el GIF exige sus opciones; un preset desconocido se rechaza', () => {
    expect(parse({ preset: 'gif' }).success).toBe(false);
    expect(
      parse({ preset: 'gif', gif: { startSeconds: 0, endSeconds: 5, fps: 10, width: 480 } })
        .success,
    ).toBe(true);
    expect(parse({ preset: 'exe' }).success).toBe(false);
  });

  it('baja M4A para presets de audio y MP4 para video y GIF', () => {
    expect(followUpDownloadFormat('mp3')).toBe('m4a');
    expect(followUpDownloadFormat('wav')).toBe('m4a');
    expect(followUpDownloadFormat('webm')).toBe('mp4');
    expect(followUpDownloadFormat('gif')).toBe('mp4');
  });
});

describe('notify (D-104)', () => {
  it('ids de cuentas sin repetidos; otra cosa no', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(
      downloadRequestSchema.parse({ url: 'https://youtu.be/x', notify: [id, id] }).notify,
    ).toEqual([id]);
    expect(
      downloadRequestSchema.safeParse({ url: 'https://youtu.be/x', notify: ['a@b.ar'] }).success,
    ).toBe(false);
  });
});
