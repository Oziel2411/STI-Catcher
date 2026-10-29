import { describe, expect, it } from 'vitest';
import { readJsonFixture } from '../../../test/fixtures.ts';
import { parseFfprobeOutput } from '../../adapters/ffprobe.ts';
import { buildRecordingArgs } from './recording-args.ts';

/** Salidas reales de MediaRecorder (Chrome 152), analizadas con ffprobe. */
const chromeMp4 = parseFfprobeOutput(readJsonFixture('ffprobe-mediarecorder-chrome-mp4.json'));
const chromeWebm = parseFfprobeOutput(readJsonFixture('ffprobe-mediarecorder-chrome-webm.json'));

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const build = (media = chromeWebm) =>
  buildRecordingArgs({
    inputPath: 'S:\\rec\\in.webm',
    outputPath: 'S:\\tmp\\out.mp4',
    media,
    fps: 30,
  });

describe('fixtures de MediaRecorder', () => {
  it('el WebM no trae duración (por eso hay que procesarlo); el MP4 sí', () => {
    expect(chromeWebm.durationSeconds).toBeNull();
    expect(chromeWebm.video?.codec).toBe('vp9');
    expect(chromeMp4.video?.codec).toBe('h264');
    expect(chromeMp4.audio?.codec).toBe('aac');
    expect(chromeMp4.durationSeconds).toBeCloseTo(3.98, 1);
  });
});

describe('buildRecordingArgs', () => {
  it('MP4 H.264 + AAC de Chrome: se remuxea con el índice al principio', () => {
    const plan = build(chromeMp4);
    expect(plan.mode).toBe('copy');
    expect(after(plan.args, '-c')).toBe('copy');
    expect(after(plan.args, '-movflags')).toBe('+faststart');
  });

  it('WebM VP9/Opus: se recodifica a H.264 + AAC, a cuadros constantes', () => {
    const plan = build();
    expect(plan.mode).toBe('encode');
    expect(after(plan.args, '-c:v')).toBe('libx264');
    expect(after(plan.args, '-c:a')).toBe('aac');
    expect(after(plan.args, '-fps_mode')).toBe('cfr');
    expect(after(plan.args, '-r')).toBe('30');
    expect(after(plan.args, '-pix_fmt')).toBe('yuv420p');
  });

  it('fuerza ancho y alto pares (una ventana puede medir 1365×767)', () => {
    expect(after(build().args, '-vf')).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  });

  it('mapea video y audio por tipo: en el MP4 de Chrome el audio es el primer stream', () => {
    const { args } = build(chromeMp4);
    const maps = args.flatMap((arg, i) => (arg === '-map' ? [args[i + 1]] : []));
    expect(maps).toEqual(['0:v:0', '0:a:0?']);
  });

  it('el audio es opcional (grabación sin sonido)', () => {
    const plan = build({ ...chromeWebm, audio: null });
    expect(plan.args).toContain('0:a:0?');
  });
});
