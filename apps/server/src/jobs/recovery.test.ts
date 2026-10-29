import { describe, expect, it, vi } from 'vitest';
import { INTERRUPTED_MESSAGE } from './errors.ts';
import { recoverOnStartup } from './recovery.ts';
import type { RecoveryDeps } from './recovery.ts';

function setup(overrides: Partial<RecoveryDeps> = {}) {
  const calls: string[] = [];
  const deps: RecoveryDeps = {
    repo: {
      failAllRunning: vi.fn(() => {
        calls.push('failAllRunning');
        return ['job-1'];
      }),
    },
    listProcesses: vi.fn(() =>
      Promise.resolve([
        { pid: 10, executablePath: 'D:\\sti\\bin\\ffmpeg.exe' },
        { pid: 11, executablePath: 'C:\\Windows\\explorer.exe' },
        { pid: 12, executablePath: 'D:\\sti\\bin\\yt-dlp.exe' },
      ]),
    ),
    killProcessTree: vi.fn((pid: number) => {
      calls.push(`kill:${String(pid)}`);
      return Promise.resolve();
    }),
    files: {
      emptyDir: vi.fn(() => {
        calls.push('emptyDir');
        return Promise.resolve(3);
      }),
    },
    binDir: 'D:\\sti\\bin',
    tempDir: 'D:\\sti\\storage\\tmp',
    selfPid: 999,
    now: () => new Date('2026-10-29T12:00:00.000Z'),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { deps, calls };
}

describe('recoverOnStartup', () => {
  it('mata huérfanos, vacía tmp y marca los running como interrumpidos, en ese orden', async () => {
    const { deps, calls } = setup();
    const report = await recoverOnStartup(deps);

    expect(calls).toEqual(['kill:10', 'kill:12', 'emptyDir', 'failAllRunning']);
    expect(deps.files.emptyDir).toHaveBeenCalledWith('D:\\sti\\storage\\tmp');
    expect(deps.repo.failAllRunning).toHaveBeenCalledWith(
      INTERRUPTED_MESSAGE,
      '2026-10-29T12:00:00.000Z',
    );
    expect(report).toEqual({
      killedProcesses: [
        { pid: 10, executablePath: 'D:\\sti\\bin\\ffmpeg.exe' },
        { pid: 12, executablePath: 'D:\\sti\\bin\\yt-dlp.exe' },
      ],
      removedTempEntries: 3,
      interruptedJobIds: ['job-1'],
    });
  });

  it('si no puede listar procesos, avisa en el log y sigue con el resto', async () => {
    const { deps, calls } = setup({
      listProcesses: () => Promise.reject(new Error('powershell no disponible')),
    });
    const report = await recoverOnStartup(deps);
    expect(report.killedProcesses).toEqual([]);
    expect(calls).toEqual(['emptyDir', 'failAllRunning']);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('no mata procesos ajenos a BIN_DIR', async () => {
    const { deps } = setup({
      listProcesses: () =>
        Promise.resolve([{ pid: 50, executablePath: 'C:\\Program Files\\ffmpeg\\ffmpeg.exe' }]),
    });
    await recoverOnStartup(deps);
    expect(deps.killProcessTree).not.toHaveBeenCalled();
  });
});
