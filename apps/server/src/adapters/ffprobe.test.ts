import { describe, expect, it } from 'vitest';
import { readFixture, readJsonFixture } from '../../test/fixtures.ts';
import {
  buildFfprobeArgs,
  createFfprobe,
  FfprobeError,
  parseFfprobeOutput,
  parseFrameRate,
} from './ffprobe.ts';

describe('buildFfprobeArgs', () => {
  it('pide JSON con formato y streams; la ruta va después de "--"', () => {
    expect(buildFfprobeArgs('D:\\a b\\x.mp4')).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '--',
      'D:\\a b\\x.mp4',
    ]);
  });
});

describe('parseFfprobeOutput (salidas reales)', () => {
  it('MP4 H.264 + AAC', () => {
    const info = parseFfprobeOutput(readJsonFixture('ffprobe-sample-mp4.json'));
    expect(info.video).toEqual({
      codec: 'h264',
      width: 1280,
      height: 720,
      pixFmt: 'yuv420p',
      frameRate: 30,
    });
    expect(info.audio).toEqual({ codec: 'aac', channels: 1 });
    expect(info.durationSeconds).toBeCloseTo(3, 0);
    expect(info.formatName).toContain('mp4');
    expect(info.sizeBytes).toBeGreaterThan(0);
  });

  it('cuadros por segundo: promedio real; desconocido en el WebM de MediaRecorder', () => {
    const iphone = parseFfprobeOutput(readJsonFixture('ffprobe-iphone-hevc-mov.json'));
    const mp4 = parseFfprobeOutput(readJsonFixture('ffprobe-mediarecorder-chrome-mp4.json'));
    const webm = parseFfprobeOutput(readJsonFixture('ffprobe-mediarecorder-chrome-webm.json'));
    expect(iphone.video?.frameRate).toBe(30);
    // MediaRecorder da cuadros variables: el promedio no es redondo.
    expect(mp4.video?.frameRate).toBeCloseTo(435000 / 14921, 3);
    // avg_frame_rate "0/0" y r_frame_rate "1000/1" (la base de tiempo): no se sabe.
    expect(webm.video?.frameRate).toBeNull();
  });

  it('video vertical de celular (rotación 90°): ancho y alto como se ve', () => {
    const rotated = parseFfprobeOutput(readJsonFixture('ffprobe-rotated-90-mp4.json'));
    expect(rotated.video).toMatchObject({ width: 1080, height: 1920 });
  });

  it('parseFrameRate: fracciones, desconocidos y absurdos', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('0/0')).toBeNull();
    expect(parseFrameRate('1000/1')).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
    expect(parseFrameRate('abc')).toBeNull();
  });

  it('MP3: solo audio', () => {
    const info = parseFfprobeOutput(readJsonFixture('ffprobe-sample-mp3.json'));
    expect(info.video).toBeNull();
    expect(info.audio).toEqual({ codec: 'mp3', channels: 1 });
    expect(info.formatName).toBe('mp3');
  });

  it('una portada (attached_pic) no cuenta como video', () => {
    const info = parseFfprobeOutput({
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '19.0' },
    });
    expect(info.video).toBeNull();
    expect(info.durationSeconds).toBe(19);
  });
});

describe('createFfprobe', () => {
  it('ejecuta ffprobe y parsea', async () => {
    const probe = createFfprobe(
      () =>
        Promise.resolve({
          exitCode: 0,
          stdout: readFixture('ffprobe-sample-mp3.json'),
          stderr: '',
          timedOut: false,
        }),
      'ffprobe.exe',
    );
    expect((await probe('x.mp3')).audio?.codec).toBe('mp3');
  });

  it('lanza FfprobeError si ffprobe falla', async () => {
    const probe = createFfprobe(
      () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Invalid data', timedOut: false }),
      'ffprobe.exe',
    );
    await expect(probe('x.mp4')).rejects.toBeInstanceOf(FfprobeError);
  });
});
