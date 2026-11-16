import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from './process.ts';
import {
  buildEncoderProbeArgs,
  createEncoderRegistry,
  detectVideoEncoders,
} from './video-encoders.ts';

const logger = { info: vi.fn(), warn: vi.fn() };
const ok: CommandResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
// Lo que devolvió hevc_qsv en la Intel HD 630 con los parámetros por defecto (D-108).
const unsupported: CommandResult = {
  exitCode: 4294967274,
  stdout: '',
  stderr: '[hevc_qsv @ 00000225101d63c0] Error querying encoder params: unsupported (-3)',
  timedOut: false,
};

describe('buildEncoderProbeArgs', () => {
  it('prueba en NV12 y sin archivo de salida', () => {
    const args = buildEncoderProbeArgs('hevc_qsv');
    expect(args[args.indexOf('-c:v') + 1]).toBe('hevc_qsv');
    expect(args[args.indexOf('-vf') + 1]).toBe('format=nv12');
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(args).toContain('-nostdin');
  });
});

describe('detectVideoEncoders', () => {
  it('usa la GPU para cada códec que codifica de verdad', async () => {
    const run = vi.fn<CommandRunner>((_file, args) =>
      Promise.resolve(args.includes('hevc_qsv') ? unsupported : ok),
    );
    await expect(detectVideoEncoders(run, 'B:\\ffmpeg.exe', logger)).resolves.toEqual({
      h264: 'qsv',
      hevc: 'cpu',
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('si la prueba tarda o el proceso no arranca, CPU', async () => {
    const run = vi.fn<CommandRunner>((_file, args) =>
      args.includes('h264_qsv')
        ? Promise.resolve({ ...ok, timedOut: true, exitCode: null })
        : Promise.reject(new Error('spawn ENOENT')),
    );
    await expect(detectVideoEncoders(run, 'B:\\ffmpeg.exe', logger)).resolves.toEqual({
      h264: 'cpu',
      hevc: 'cpu',
    });
  });
});

describe('createEncoderRegistry', () => {
  it('un códec cuya GPU falló pasa a CPU; el otro sigue igual', async () => {
    const registry = createEncoderRegistry(Promise.resolve({ h264: 'qsv', hevc: 'qsv' }));
    expect(registry.peek()).toBeNull();
    registry.markGpuFailed('hevc');
    await expect(registry.current()).resolves.toEqual({ h264: 'qsv', hevc: 'cpu' });
    expect(registry.peek()).toEqual({ h264: 'qsv', hevc: 'cpu' });
  });

  it('si la detección falla, todo por CPU', async () => {
    const registry = createEncoderRegistry(Promise.reject(new Error('boom')));
    await expect(registry.current()).resolves.toEqual({ h264: 'cpu', hevc: 'cpu' });
  });
});
