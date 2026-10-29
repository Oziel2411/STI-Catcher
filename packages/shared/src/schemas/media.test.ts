import { describe, expect, it } from 'vitest';
import { downloadRequestSchema, probeRequestSchema } from './media.ts';

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
