import { describe, expect, it } from 'vitest';
import { buildTaskkillArgs, runCommand } from './process.ts';

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
