import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireInstanceLock, InstanceLockError } from './instance-lock.ts';

const dirs: string[] = [];
const lockFile = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sti-lock-'));
  dirs.push(dir);
  return path.join(dir, 'sti-catcher.pid');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('acquireInstanceLock', () => {
  it('sin lock previo, escribe el PID propio y lo borra al liberar', async () => {
    const lockPath = lockFile();
    const lock = await acquireInstanceLock({ lockPath, selfPid: 42, isOtherInstance: vi.fn() });
    expect(readFileSync(lockPath, 'utf8')).toBe('42');
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('se niega a arrancar si otra instancia está viva', async () => {
    const lockPath = lockFile();
    writeFileSync(lockPath, '1000');
    const attempt = acquireInstanceLock({
      lockPath,
      selfPid: 42,
      isOtherInstance: (pid) => Promise.resolve(pid === 1000),
    });
    await expect(attempt).rejects.toBeInstanceOf(InstanceLockError);
    await expect(attempt).rejects.toThrow(/PID 1000/);
    expect(readFileSync(lockPath, 'utf8')).toBe('1000');
  });

  it('toma el lock si el anterior quedó de una ejecución que ya no existe', async () => {
    const lockPath = lockFile();
    writeFileSync(lockPath, '1000');
    await acquireInstanceLock({
      lockPath,
      selfPid: 42,
      isOtherInstance: () => Promise.resolve(false),
    });
    expect(readFileSync(lockPath, 'utf8')).toBe('42');
  });

  it('ignora contenido basura', async () => {
    const lockPath = lockFile();
    writeFileSync(lockPath, 'no-es-un-pid');
    const isOtherInstance = vi.fn();
    await acquireInstanceLock({ lockPath, selfPid: 42, isOtherInstance });
    expect(isOtherInstance).not.toHaveBeenCalled();
  });

  it('release no borra el lock si otra instancia lo tomó después', async () => {
    const lockPath = lockFile();
    const lock = await acquireInstanceLock({ lockPath, selfPid: 42, isOtherInstance: vi.fn() });
    writeFileSync(lockPath, '77');
    lock.release();
    expect(readFileSync(lockPath, 'utf8')).toBe('77');
  });
});
