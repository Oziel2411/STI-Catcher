import type { EditPrecision, EditSegment } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import { readJsonFixture } from '../../../test/fixtures.ts';
import { parseFfprobeOutput } from '../../adapters/ffprobe.ts';
import type { MediaInfo } from '../../adapters/ffprobe.ts';
import { buildEditArgs, formatSeconds } from './edit-args.ts';

/** Grabación de Chrome (H.264 + AAC) y la misma sin audio. */
const recording = parseFfprobeOutput(readJsonFixture('ffprobe-mediarecorder-chrome-mp4.json'));
const silent: MediaInfo = { ...recording, audio: null };

const INPUT = 'S:\\storage\\files\\abc.mp4';
const OUTPUT = 'S:\\tmp\\job.mp4';
const LIST = 'S:\\tmp\\job-list.txt';

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const count = (args: string[], value: string) => args.filter((a) => a === value).length;
const build = (
  segments: EditSegment[],
  precision: EditPrecision = 'exact',
  media: MediaInfo = recording,
  inputPath = INPUT,
) =>
  buildEditArgs({
    inputPath,
    outputPath: OUTPUT,
    concatListPath: LIST,
    media,
    segments,
    precision,
  });

describe('formatSeconds', () => {
  it('redondea a milisegundos y nunca da negativo', () => {
    expect(formatSeconds(12.3456)).toBe('12.346');
    expect(formatSeconds(0.1 + 0.2)).toBe('0.3');
    expect(formatSeconds(90)).toBe('90');
    expect(formatSeconds(-0.0001)).toBe('0');
  });
});

describe('buildEditArgs: exacto', () => {
  it('un tramo: busca antes de -i, recodifica a H.264 + AAC y termina en el MP4', () => {
    const plan = build([{ start: 5.5, end: 20 }]);
    expect(plan.args.slice(plan.args.indexOf('-ss'), plan.args.indexOf('-i') + 2)).toEqual([
      '-ss',
      '5.5',
      '-t',
      '14.5',
      '-i',
      INPUT,
    ]);
    expect(after(plan.args, '-c:v')).toBe('libx264');
    expect(after(plan.args, '-crf')).toBe('18');
    expect(after(plan.args, '-c:a')).toBe('aac');
    expect(after(plan.args, '-vf')).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    expect(after(plan.args, '-movflags')).toBe('+faststart');
    expect(plan.args.at(-1)).toBe(OUTPUT);
    expect(plan.totalDurationSeconds).toBeCloseTo(14.5);
    expect(plan.concatList).toBeNull();
  });

  it('un tramo: el audio es opcional', () => {
    const plan = build([{ start: 0, end: 3 }], 'exact', silent);
    expect(plan.args).toContain('0:a:0?');
  });

  it('varios tramos: abre el archivo una vez por tramo y los une con concat', () => {
    const plan = build([
      { start: 0, end: 10 },
      { start: 30, end: 45.25 },
    ]);
    expect(count(plan.args, INPUT)).toBe(2);
    expect(count(plan.args, '-ss')).toBe(2);
    expect(plan.args).toContain('30');
    expect(plan.args).toContain('15.25');
    expect(after(plan.args, '-filter_complex')).toBe(
      '[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[vcat][a];[vcat]scale=trunc(iw/2)*2:trunc(ih/2)*2[v]',
    );
    expect(plan.args.join(' ')).toContain('-map [v] -map [a]');
    expect(plan.totalDurationSeconds).toBeCloseTo(25.25);
  });

  it('varios tramos sin audio: concat solo de video y sin códec de audio', () => {
    const plan = build(
      [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
        { start: 4, end: 5 },
      ],
      'exact',
      silent,
    );
    expect(after(plan.args, '-filter_complex')).toBe(
      '[0:v:0][1:v:0][2:v:0]concat=n=3:v=1:a=0[vcat];[vcat]scale=trunc(iw/2)*2:trunc(ih/2)*2[v]',
    );
    expect(plan.args).not.toContain('[a]');
    expect(plan.args).not.toContain('-c:a');
  });
});

describe('buildEditArgs: rápido (sin recodificar)', () => {
  it('un tramo: copia y deja los tiempos empezando en 0', () => {
    const plan = build([{ start: 60, end: 75 }], 'fast');
    expect(after(plan.args, '-ss')).toBe('60');
    expect(after(plan.args, '-t')).toBe('15');
    expect(after(plan.args, '-c')).toBe('copy');
    expect(after(plan.args, '-avoid_negative_ts')).toBe('make_zero');
    expect(plan.args).not.toContain('-c:v');
    expect(plan.concatList).toBeNull();
  });

  it('varios tramos: lista ffconcat con inpoint y outpoint, y copia', () => {
    const plan = build(
      [
        { start: 0, end: 10 },
        { start: 30, end: 45 },
      ],
      'fast',
    );
    expect(plan.args.join(' ')).toContain(`-f concat -safe 0 -i ${LIST}`);
    expect(after(plan.args, '-c')).toBe('copy');
    expect(plan.concatList).toBe(
      [
        'ffconcat version 1.0',
        `file '${INPUT}'`,
        'inpoint 0',
        'outpoint 10',
        `file '${INPUT}'`,
        'inpoint 30',
        'outpoint 45',
        '',
      ].join('\n'),
    );
  });

  it('las comillas de la ruta se escapan como pide ffconcat', () => {
    const plan = build(
      [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ],
      'fast',
      recording,
      "S:\\it's\\a.mp4",
    );
    expect(plan.concatList).toContain("file 'S:\\it'\\''s\\a.mp4'");
  });
});

it('sin tramos es un error de programación', () => {
  expect(() => build([])).toThrow();
});
