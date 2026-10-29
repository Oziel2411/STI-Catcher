import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsDir = import.meta.dirname;
const ps1Files = readdirSync(scriptsDir).filter((name) => name.endsWith('.ps1'));

/**
 * Windows PowerShell 5.1 lee los .ps1 sin BOM como ANSI: las tildes y la ñ de
 * los mensajes se rompen y algunos strings quedan mal cerrados. Por eso todos
 * los scripts se guardan en UTF-8 con BOM.
 */
describe('scripts de PowerShell', () => {
  it('existe al menos uno', () => {
    expect(ps1Files.length).toBeGreaterThan(0);
  });

  it.each(ps1Files)('%s está en UTF-8 con BOM', (name) => {
    const bytes = readFileSync(path.join(scriptsDir, name));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
