import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from './process.ts';
import { createToolVersionReader, parseToolVersion } from './tool-version.ts';

describe('parseToolVersion', () => {
  it('yt-dlp: versión por fecha, con o sin número de build', () => {
    expect(parseToolVersion('yt-dlp', '2026.10.20\r\n')).toBe('2026.10.20');
    expect(parseToolVersion('yt-dlp', '2026.10.20.123456\n')).toBe('2026.10.20.123456');
  });

  it('ffmpeg y ffprobe: toma la versión de la primera línea', () => {
    const ffmpeg =
      'ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\r\nbuilt with gcc 15.2.0';
    expect(parseToolVersion('ffmpeg', ffmpeg)).toBe('9.0.2-essentials_build-www.gyan.dev');
    expect(parseToolVersion('ffprobe', 'ffprobe version 9.0.2 Copyright')).toBe('9.0.2');
  });

  it('deno: primera línea "deno X.Y.Z (...)"', () => {
    const deno = 'deno 2.6.3 (stable, release, x86_64-pc-windows-msvc)\nv8 14.0\ntypescript 5.9';
    expect(parseToolVersion('deno', deno)).toBe('2.6.3');
  });

  it('devuelve null si el formato no coincide', () => {
    expect(parseToolVersion('yt-dlp', 'Usage: yt-dlp [OPTIONS]')).toBeNull();
    expect(parseToolVersion('ffmpeg', 'ffprobe version 9.0')).toBeNull();
    expect(parseToolVersion('deno', '')).toBeNull();
  });
});

describe('createToolVersionReader', () => {
  const ok = (stdout: string): CommandResult => ({
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
  });

  it('devuelve la versión cuando el comando responde bien', async () => {
    const run: CommandRunner = () => Promise.resolve(ok('2026.10.20'));
    await expect(createToolVersionReader(run)('yt-dlp', 'x.exe')).resolves.toEqual({
      version: '2026.10.20',
      error: null,
    });
  });

  it('informa "no encontrado" si el ejecutable no existe', async () => {
    const run: CommandRunner = () =>
      Promise.reject(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }));
    const result = await createToolVersionReader(run)('deno', 'x.exe');
    expect(result.version).toBeNull();
    expect(result.error).toMatch(/No encontrado/);
  });

  it('informa timeout y formato inesperado sin lanzar', async () => {
    const slow: CommandRunner = () => Promise.resolve({ ...ok(''), timedOut: true });
    expect((await createToolVersionReader(slow)('ffmpeg', 'x')).error).toMatch(/a tiempo/);

    const weird: CommandRunner = () => Promise.resolve(ok('???'));
    expect((await createToolVersionReader(weird)('ffmpeg', 'x')).error).toMatch(/inesperado/);
  });
});
