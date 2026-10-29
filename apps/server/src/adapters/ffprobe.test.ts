import { describe, expect, it } from 'vitest';
import { readFixture, readJsonFixture } from '../../test/fixtures.ts';
import { buildFfprobeArgs, createFfprobe, FfprobeError, parseFfprobeOutput } from './ffprobe.ts';

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
    expect(info.video).toEqual({ codec: 'h264', width: 1280, height: 720 });
    expect(info.audio).toEqual({ codec: 'aac' });
    expect(info.durationSeconds).toBeCloseTo(3, 0);
    expect(info.formatName).toContain('mp4');
    expect(info.sizeBytes).toBeGreaterThan(0);
  });

  it('MP3: solo audio', () => {
    const info = parseFfprobeOutput(readJsonFixture('ffprobe-sample-mp3.json'));
    expect(info.video).toBeNull();
    expect(info.audio).toEqual({ codec: 'mp3' });
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
