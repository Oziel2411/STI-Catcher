import { describe, expect, it } from 'vitest';
import { readJsonFixture } from '../../../test/fixtures.ts';
import { parseFfprobeOutput } from '../../adapters/ffprobe.ts';
import { buildConversionArgs } from './conversion-args.ts';
import type { ConversionArgsOptions } from './conversion-args.ts';

/** Datos reales de ffprobe (fixtures). */
const iphoneHevc = parseFfprobeOutput(readJsonFixture('ffprobe-iphone-hevc-mov.json'));
const androidH264 = parseFfprobeOutput(readJsonFixture('ffprobe-camara-h264-mov.json'));
const voiceNote = parseFfprobeOutput(readJsonFixture('ffprobe-nota-de-voz-m4a.json'));
const mp3 = parseFfprobeOutput(readJsonFixture('ffprobe-sample-mp3.json'));

const build = (overrides: Partial<ConversionArgsOptions> & Pick<ConversionArgsOptions, 'preset'>) =>
  buildConversionArgs({
    inputPath: 'S:\\files\\in put.mov',
    outputPath: 'S:\\tmp\\out.x',
    media: iphoneHevc,
    maxHeight: null,
    ...overrides,
  });

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('fixtures', () => {
  it('el .mov de iPhone es HEVC 1920x1080 + AAC; la nota de voz, solo audio', () => {
    expect(iphoneHevc.video).toMatchObject({
      codec: 'hevc',
      width: 1920,
      height: 1080,
      pixFmt: 'yuv420p',
    });
    expect(voiceNote.video).toBeNull();
    expect(voiceNote.audio?.codec).toBe('aac');
  });
});

describe('buildConversionArgs', () => {
  it('todas las salidas: entrada y salida como argumentos únicos, progreso por stdout', () => {
    const { args } = build({ preset: 'mp4' });
    expect(after(args, '-i')).toBe('S:\\files\\in put.mov');
    expect(args.at(-1)).toBe('S:\\tmp\\out.x');
    expect(after(args, '-progress')).toBe('pipe:1');
    expect(args).toContain('-nostdin');
  });

  it('MOV HEVC de iPhone → MP4: recodifica a H.264 8 bits + AAC, con faststart', () => {
    const plan = build({ preset: 'mp4' });
    expect(plan.mode).toBe('encode');
    expect(after(plan.args, '-c:v')).toBe('libx264');
    expect(after(plan.args, '-pix_fmt')).toBe('yuv420p');
    expect(after(plan.args, '-c:a')).toBe('aac');
    expect(after(plan.args, '-movflags')).toBe('+faststart');
    expect(plan.totalDurationSeconds).toBe(12);
  });

  it('MOV H.264 + AAC → MP4: copia sin recodificar', () => {
    const plan = build({ preset: 'mp4', media: androidH264 });
    expect(plan.mode).toBe('copy');
    expect(after(plan.args, '-c')).toBe('copy');
    expect(plan.args).not.toContain('libx264');
  });

  it('escalar fuerza recodificar, solo hacia abajo y con ancho par', () => {
    const scaled = build({ preset: 'mp4', media: androidH264, maxHeight: 480 });
    expect(scaled.mode).toBe('encode');
    expect(after(scaled.args, '-vf')).toBe('scale=-2:480');
    // 720p pedido a 1080p: no se agranda.
    const notUp = build({ preset: 'mp4', media: androidH264, maxHeight: 1080 });
    expect(notUp.args).not.toContain('-vf');
    expect(notUp.mode).toBe('copy');
  });

  it('MKV: cambia solo el contenedor si no se escala', () => {
    expect(build({ preset: 'mkv' }).mode).toBe('copy');
    expect(build({ preset: 'mkv', maxHeight: 720 }).mode).toBe('encode');
  });

  it('WebM: VP9 + Opus', () => {
    const { args } = build({ preset: 'webm' });
    expect(after(args, '-c:v')).toBe('libvpx-vp9');
    expect(after(args, '-c:a')).toBe('libopus');
  });

  it('AVI: MPEG-4 con tag XVID + MP3 estéreo', () => {
    const { args } = build({ preset: 'avi' });
    expect(after(args, '-c:v')).toBe('mpeg4');
    expect(after(args, '-vtag')).toBe('XVID');
    expect(after(args, '-c:a')).toBe('libmp3lame');
  });

  it('MP3 desde un MOV: solo el audio (-vn), sin video', () => {
    const { args } = build({ preset: 'mp3' });
    expect(args).toContain('-vn');
    expect(after(args, '-map')).toBe('0:a:0');
    expect(after(args, '-c:a')).toBe('libmp3lame');
  });

  it('copia el audio cuando ya está en el formato pedido', () => {
    expect(build({ preset: 'mp3', media: mp3 }).mode).toBe('copy');
    expect(build({ preset: 'm4a', media: voiceNote }).mode).toBe('copy');
    expect(build({ preset: 'wav', media: voiceNote }).mode).toBe('encode');
  });

  it('baja a estéreo un audio 5.1 para MP3; mono queda mono', () => {
    const surround = { ...voiceNote, audio: { codec: 'ac3', channels: 6 } };
    expect(after(build({ preset: 'mp3', media: surround }).args, '-ac')).toBe('2');
    expect(build({ preset: 'mp3', media: voiceNote }).args).not.toContain('-ac');
  });

  it('GIF: recorte antes de -i, paleta propia, sin audio, progreso contra el fragmento', () => {
    const plan = build({
      preset: 'gif',
      gif: { startSeconds: 2.5, endSeconds: 7.5, fps: 12, width: 480 },
    });
    const { args } = plan;
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(after(args, '-ss')).toBe('2.500');
    expect(after(args, '-t')).toBe('5.000');
    const filter = after(args, '-filter_complex') ?? '';
    expect(filter).toContain('fps=12');
    expect(filter).toContain("scale='min(480,iw)':-1");
    expect(filter).toContain('palettegen');
    expect(filter).toContain('paletteuse');
    expect(args).toContain('-an');
    expect(plan.totalDurationSeconds).toBe(5);
  });

  it('GIF sin opciones es un error de programación', () => {
    expect(() => build({ preset: 'gif' })).toThrow();
  });
});
