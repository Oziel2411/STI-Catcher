import { describe, expect, it } from 'vitest';
import { parseProcessList, selectOrphanProcesses } from './process-list.ts';

describe('parseProcessList', () => {
  it('acepta un array (varios procesos) o un objeto (uno solo)', () => {
    expect(
      parseProcessList(
        '[{"ProcessId":10,"ExecutablePath":"C:\\\\a.exe"},{"ProcessId":20,"ExecutablePath":"C:\\\\b.exe"}]',
      ),
    ).toEqual([
      { pid: 10, executablePath: 'C:\\a.exe' },
      { pid: 20, executablePath: 'C:\\b.exe' },
    ]);
    expect(parseProcessList('{"ProcessId":10,"ExecutablePath":"C:\\\\a.exe"}')).toEqual([
      { pid: 10, executablePath: 'C:\\a.exe' },
    ]);
  });

  it('ignora entradas incompletas y salida vacía', () => {
    expect(parseProcessList('[{"ProcessId":10,"ExecutablePath":null},{"ProcessId":0}]')).toEqual(
      [],
    );
    expect(parseProcessList('  ')).toEqual([]);
  });
});

describe('selectOrphanProcesses', () => {
  const binDir = 'D:\\STI-Catcher\\bin';
  const processes = [
    { pid: 100, executablePath: 'D:\\STI-Catcher\\bin\\ffmpeg.exe' },
    { pid: 101, executablePath: 'd:\\sti-catcher\\BIN\\yt-dlp.exe' }, // Windows no distingue mayúsculas
    { pid: 102, executablePath: 'C:\\Program Files\\ffmpeg\\ffmpeg.exe' }, // otro ffmpeg del sistema
    { pid: 103, executablePath: 'D:\\STI-Catcher\\bin-old\\ffmpeg.exe' }, // carpeta con prefijo parecido
    { pid: 104, executablePath: 'D:\\STI-Catcher\\bin\\deno.exe' },
  ];

  it('elige solo los ejecutables dentro de BIN_DIR', () => {
    expect(selectOrphanProcesses(processes, binDir, 1).map((p) => p.pid)).toEqual([100, 101, 104]);
  });

  it('nunca incluye al propio proceso', () => {
    expect(selectOrphanProcesses(processes, binDir, 104).map((p) => p.pid)).toEqual([100, 101]);
  });
});
