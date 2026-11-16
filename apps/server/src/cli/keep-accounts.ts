/**
 * Migración a otro servidor sin historial: en la base deja solo las cuentas,
 * con sus contraseñas, y borra trabajos, grabaciones, avisos, sesiones y links
 * de recuperación. `npm run db:keep-accounts` (la base del `.env`) o
 * `npm run db:keep-accounts <ruta>` (otra copia).
 *
 * Se corre sobre una COPIA, en el servidor nuevo y con el servicio detenido:
 * si STI-Catcher tiene la base abierta, no hace nada. Pide escribir BORRAR.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { InstanceLockError, acquireInstanceLock } from '../adapters/instance-lock.ts';
import { ConfigError, loadConfig, resolveEnvFilePath } from '../config/env.ts';
import { openDatabase } from '../db/connection.ts';
import {
  CLEARED_TABLES,
  UnknownTablesError,
  assertKnownTables,
  countRows,
  keepOnlyAccounts,
} from '../db/keep-accounts.ts';
import { migrate } from '../db/migrate.ts';
import { migrations } from '../db/migrations.ts';

// Este archivo vive en apps/server/src/cli: la raíz del repo está cuatro niveles arriba.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

class CliError extends Error {}

/**
 * La ruta va sin opción delante: PowerShell 5.1 se come el `--` de
 * `npm run x -- --db ...` y npm se quedaría con `--db`.
 */
function resolveDbPath(args: string[]): string {
  const [value, ...rest] = args.filter((arg) => arg !== '--');
  if (rest.length > 0) throw new CliError('Pasá una sola ruta: la de la base a limpiar.');
  if (value === undefined) {
    const config = loadConfig(resolveEnvFilePath(repoRoot));
    return path.join(config.paths.data, 'sti-catcher.db');
  }
  return path.resolve(value);
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath(process.argv.slice(2));
  if (!existsSync(dbPath)) throw new CliError(`No existe ${dbPath}.`);

  // El mismo lock que el server (D-033): con el servicio andando, no se toca la base.
  const lock = await acquireInstanceLock({
    lockPath: path.join(path.dirname(dbPath), 'sti-catcher.pid'),
    selfPid: process.pid,
    isOtherInstance: (pid) => {
      try {
        process.kill(pid, 0);
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
  });
  try {
    const db = openDatabase(dbPath);
    try {
      migrate(db, migrations);
      assertKnownTables(db);
      const counts = countRows(db);
      console.log(`\nBase: ${dbPath}\n`);
      console.log(`  Se conservan: ${String(counts.users ?? 0)} cuentas (con sus contraseñas).`);
      console.log('  Se borran:');
      for (const table of CLEARED_TABLES)
        console.log(`    ${table}: ${String(counts[table] ?? 0)}`);
      console.log(
        '\n  No se puede deshacer. Hacelo sobre una copia: la original queda en el servidor viejo.\n',
      );

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Escribí BORRAR para seguir: ');
      rl.close();
      if (answer.trim() !== 'BORRAR') {
        console.log('\nNo se tocó nada.\n');
        return;
      }

      const summary = keepOnlyAccounts(db);
      const total = Object.values(summary.deleted).reduce((a, b) => a + b, 0);
      console.log(
        `\nListo: quedaron ${String(summary.users)} cuentas y se borraron ${String(total)} filas. Todos vuelven a ingresar con su contraseña.\n`,
      );
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

main().catch((error: unknown) => {
  if (error instanceof InstanceLockError) {
    console.error(
      '\n[STI-Catcher] La app está usando esa base: detené el servicio y probá de nuevo.\n',
    );
  } else if (
    error instanceof ConfigError ||
    error instanceof UnknownTablesError ||
    error instanceof CliError
  ) {
    console.error(`\n[STI-Catcher] ${error.message}\n`);
  } else {
    console.error('[STI-Catcher] No se pudo limpiar la base:', error);
  }
  process.exit(1);
});
