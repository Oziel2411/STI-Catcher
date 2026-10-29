import { readFileSync } from 'node:fs';
import path from 'node:path';

const fixturesDir = path.join(import.meta.dirname, 'fixtures');

/** Contenido de un fixture (ver test/fixtures/README.md). */
export const readFixture = (name: string): string =>
  readFileSync(path.join(fixturesDir, name), 'utf8');

export const readJsonFixture = (name: string): unknown => JSON.parse(readFixture(name)) as unknown;

/** Líneas no vacías de un fixture de texto. */
export const fixtureLines = (name: string): string[] =>
  readFixture(name)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
