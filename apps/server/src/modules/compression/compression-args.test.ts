import { compressionOptionsSchema } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import { readJsonFixture } from '../../../test/fixtures.ts';
import { parseFfprobeOutput } from '../../adapters/ffprobe.ts';
import { buildCompressionArgs } from './compression-args.ts';
import type { CompressionArgsOptions } from './compression-args.ts';

/** Datos reales de ffprobe (fixtures). */
const iphoneHevc = parseFfprobeOutput(readJsonFixture('ffprobe-iphone-hevc-mov.json'));
const chromeWebm = parseFfprobeOutput(readJsonFixture('ffprobe-mediarecorder-chrome-webm.json'));
const voiceNote = parseFfprobeOutput(readJsonFixture('ffprobe-nota-de-voz-m4a.json'));

const build = (
  options: unknown,
  overrides: Partial<Omit<CompressionArgsOptions, 'options'>> = {},
) =>
  buildCompressionArgs({
    inputPath: 'S:\\files\\in put.mov',
    outputPath: 'S:\\tmp\\job-1.mp4',
    media: iphoneHevc,
    options: compressionOptionsSchema.parse(options),
    encoder: 'cpu',
    videoKbps: null,
    passLogPrefix: 'S:\\tmp\\job-1-pass',
    ...overrides,
  });

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const only = (plan: ReturnType<typeof build>) => {
  expect(plan.runs).toHaveLength(1);
  const run = plan.runs[0];
  if (!run) throw new Error('sin ejecuciones');
  return run.args;
};

describe('buildCompressionArgs', () => {
  it('entrada y salida como argumentos únicos, progreso por stdout, MP4 con faststart', () => {
    const args = only(build({ preset: 'fast-720p' }));
    expect(after(args, '-i')).toBe('S:\\files\\in put.mov');
    expect(args.at(-1)).toBe('S:\\tmp\\job-1.mp4');
    expect(after(args, '-progress')).toBe('pipe:1');
    expect(after(args, '-movflags')).toBe('+faststart');
    expect(args.filter((a) => a === '-map')).toHaveLength(2);
    expect(args).toContain('0:a:0?');
  });

  it('calidad constante en CPU: x264 con el RF del preset, 720p, 8 bits', () => {
    const args = only(build({ preset: 'fast-720p' }));
    expect(after(args, '-c:v')).toBe('libx264');
    expect(after(args, '-preset')).toBe('veryfast');
    expect(after(args, '-crf')).toBe('22');
    expect(after(args, '-vf')).toBe('scale=1280:720:flags=lanczos,format=yuv420p');
    expect(after(args, '-c:a')).toBe('aac');
    expect(after(args, '-b:a')).toBe('128k');
    expect(args).not.toContain('-b:v');
  });

  it('calidad constante en QSV: ICQ con el mismo RF y NV12', () => {
    const args = only(build({ preset: 'fast-720p' }, { encoder: 'qsv' }));
    expect(after(args, '-c:v')).toBe('h264_qsv');
    expect(after(args, '-global_quality')).toBe('22');
    expect(after(args, '-vf')).toBe('scale=1280:720:flags=lanczos,format=nv12');
    expect(args).not.toContain('-crf');
  });

  it('H.265 (archivar): etiqueta hvc1; x265 sin ruido en el log', () => {
    const cpu = only(build({ preset: 'archive-original' }));
    expect(after(cpu, '-c:v')).toBe('libx265');
    expect(after(cpu, '-preset')).toBe('fast');
    expect(after(cpu, '-tag:v')).toBe('hvc1');
    expect(after(cpu, '-x265-params')).toBe('log-level=error');
    // 1080p a 30 cuadros: no se escala ni se tocan los cuadros.
    expect(after(cpu, '-vf')).toBe('format=yuv420p');

    const qsv = only(build({ preset: 'archive-original' }, { encoder: 'qsv' }));
    expect(after(qsv, '-c:v')).toBe('hevc_qsv');
    expect(after(qsv, '-tag:v')).toBe('hvc1');
    expect(qsv).not.toContain('-x265-params');
  });

  it('altura y audio elegidos por el usuario', () => {
    const args = only(build({ preset: 'fast-1080p', maxHeight: 480, audioKbps: 64 }));
    expect(after(args, '-vf')).toBe('scale=854:480:flags=lanczos,format=yuv420p');
    expect(after(args, '-b:a')).toBe('64k');
  });

  it('WebM de MediaRecorder sin cuadros informados: aplica el tope de 30', () => {
    const args = only(build({ preset: 'screen' }, { media: chromeWebm }));
    expect(after(args, '-vf')).toBe('fps=30,format=yuv420p');
  });

  it('tamaño objetivo en CPU: dos pasadas con el mismo log; la primera sin audio ni archivo', () => {
    const plan = build(
      { preset: 'share-720p', target: { mode: 'size', megabytes: 24 } },
      { videoKbps: 850.4 },
    );
    expect(plan.runs.map((r) => r.kind)).toEqual(['analysis', 'encode']);
    const [first, second] = plan.runs.map((r) => r.args);
    if (!first || !second) throw new Error('faltan pasadas');
    expect(after(first, '-pass')).toBe('1');
    expect(after(first, '-passlogfile')).toBe('S:\\tmp\\job-1-pass');
    expect(first).toContain('-an');
    expect(first.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(first).not.toContain('S:\\tmp\\job-1.mp4');
    expect(after(second, '-pass')).toBe('2');
    expect(after(second, '-passlogfile')).toBe('S:\\tmp\\job-1-pass');
    expect(after(second, '-b:v')).toBe('850k');
    expect(second).not.toContain('-crf');
    expect(second.at(-1)).toBe('S:\\tmp\\job-1.mp4');
  });

  it('tamaño objetivo en QSV: una pasada, bitrate variable con techo', () => {
    const args = only(
      build(
        { preset: 'share-720p', target: { mode: 'size', megabytes: 24 } },
        { encoder: 'qsv', videoKbps: 1000 },
      ),
    );
    expect(after(args, '-b:v')).toBe('1000k');
    expect(after(args, '-maxrate')).toBe('1500k');
    expect(after(args, '-bufsize')).toBe('2000k');
    expect(args).not.toContain('-pass');
    expect(args).not.toContain('-global_quality');
  });

  it('la duración del origen va al plan, para el porcentaje', () => {
    expect(build({ preset: 'screen' }).totalDurationSeconds).toBe(12);
  });

  it('sin video no hay compresión posible', () => {
    expect(() => build({ preset: 'screen' }, { media: voiceNote })).toThrow();
  });
});
