import { describe, expect, it } from 'vitest';
import { buildTaskkillArgs, createLineSplitter, runCommand, runStreaming } from './process.ts';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0); // señal 0: solo pregunta si existe
    return true;
  } catch {
    return false;
  }
};

describe('createLineSplitter', () => {
  it('separa por \\n, \\r\\n y \\r, aunque los cortes caigan a mitad de línea', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push('uno\r\ndo');
    splitter.push('s\rtres\r');
    splitter.push('\ncuatro\n\nci');
    splitter.flush();
    splitter.push('nco');
    splitter.flush();
    expect(lines).toEqual(['uno', 'dos', 'tres', 'cuatro', 'ci', 'nco']);
  });
});

describe('runStreaming', () => {
  it('entrega stdout por líneas y guarda el final de stderr', async () => {
    const lines: string[] = [];
    const result = await runStreaming(
      process.execPath,
      ['-e', 'console.log("a\\nb"); console.error("x\\ny\\nz")'],
      {
        signal: new AbortController().signal,
        onStdoutLine: (l) => lines.push(l),
        stderrTailLines: 2,
      },
    );
    expect(lines).toEqual(['a', 'b']);
    expect(result).toEqual({ exitCode: 0, stderrTail: ['y', 'z'] });
  });

  it('al abortar mata el árbol completo (hijo y nieto) y rechaza con el motivo', async () => {
    // El hijo lanza un nieto (como yt-dlp lanza ffmpeg) e imprime el PID del nieto.
    const childScript = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log('grandchild=' + grandchild.pid);
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    let grandchildPid = 0;
    const reason = new Error('cancelado');

    const promise = runStreaming(process.execPath, ['-e', childScript], {
      signal: controller.signal,
      onStdoutLine: (line) => {
        const match = /^grandchild=(\d+)$/.exec(line);
        if (match?.[1]) {
          grandchildPid = Number(match[1]);
          controller.abort(reason);
        }
      },
    });

    await expect(promise).rejects.toBe(reason);
    expect(grandchildPid).toBeGreaterThan(0);
    // taskkill /T /F es sincrónico respecto del árbol, pero damos un margen.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(grandchildPid)).toBe(false);
  }, 15_000);

  it('rechaza sin lanzar nada si la señal ya estaba abortada', async () => {
    const controller = new AbortController();
    controller.abort(new Error('antes'));
    await expect(
      runStreaming('C:\\no-existe.exe', [], { signal: controller.signal }),
    ).rejects.toThrow('antes');
  });
});

describe('buildTaskkillArgs', () => {
  it('mata el árbol completo y fuerza el cierre', () => {
    expect(buildTaskkillArgs(1234)).toEqual(['/PID', '1234', '/T', '/F']);
  });

  it('rechaza PIDs inválidos', () => {
    expect(() => buildTaskkillArgs(0)).toThrow(RangeError);
    expect(() => buildTaskkillArgs(-5)).toThrow(RangeError);
    expect(() => buildTaskkillArgs(1.5)).toThrow(RangeError);
  });
});

describe('runCommand', () => {
  it('captura stdout y el código de salida (usa el node actual, sin shell)', async () => {
    const result = await runCommand(process.execPath, ['-e', 'console.log("hola ñandú")'], {
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout.trim()).toBe('hola ñandú');
  });

  it('no interpreta metacaracteres de shell en los argumentos', async () => {
    const tricky = 'a & echo inyectado | b';
    const result = await runCommand(
      process.execPath,
      ['-e', 'console.log(process.argv[1])', tricky],
      { timeoutMs: 10_000 },
    );
    expect(result.stdout.trim()).toBe(tricky);
  });

  it('rechaza con ENOENT si el ejecutable no existe', async () => {
    await expect(
      runCommand('C:\\no-existe\\nada.exe', [], { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('corta por timeout matando el proceso', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
  });
});
