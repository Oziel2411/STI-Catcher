import { describe, expect, it } from 'vitest';
import { fileQuerySchema, historyQuerySchema } from './history.ts';

describe('historyQuerySchema', () => {
  it('por defecto: mis trabajos, primera página de 20, sin búsqueda', () => {
    expect(historyQuerySchema.parse({})).toEqual({ scope: 'mine', page: 1, pageSize: 20 });
  });

  it('una búsqueda vacía o de espacios es "sin búsqueda"', () => {
    expect(historyQuerySchema.parse({ q: '   ' }).q).toBeUndefined();
    expect(historyQuerySchema.parse({ q: ' canción ' }).q).toBe('canción');
  });

  it('valida scope, página y tamaño', () => {
    expect(historyQuerySchema.safeParse({ scope: 'otros' }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });
});

describe('fileQuerySchema', () => {
  it('inline=1 para reproducir; por defecto descarga', () => {
    expect(fileQuerySchema.parse({ inline: '1' })).toEqual({ inline: true });
    expect(fileQuerySchema.parse({})).toEqual({ inline: false });
  });
});
