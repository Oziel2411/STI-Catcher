/**
 * Crea una cuenta de administrador (D-100). Se corre en el servidor, no desde
 * la web: `npm run user:create-admin`. Pide mail, nombre y contraseña (la
 * contraseña no se muestra al escribirla y nunca se guarda en texto).
 *
 * Usa el mismo `.env` que el server (o `STI_ENV_FILE`) y la misma base. Se
 * puede correr con el servicio andando: SQLite en modo WAL lo permite.
 */
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { emailSchema } from '@sti-catcher/shared';
import { ConfigError, loadConfig, resolveEnvFilePath } from '../config/env.ts';
import { openDatabase } from '../db/connection.ts';
import { migrate } from '../db/migrate.ts';
import { migrations } from '../db/migrations.ts';
import { createSessionsRepository } from '../db/sessions-repository.ts';
import { createUsersRepository } from '../db/users-repository.ts';
import {
  AuthError,
  assertPasswordStrength,
  createAuthService,
} from '../modules/auth/auth-service.ts';
import { createLoginLimiter } from '../modules/auth/login-limiter.ts';

// Este archivo vive en apps/server/src/cli: la raíz del repo está cuatro niveles arriba.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

type Prompter = {
  ask: (question: string) => Promise<string>;
  /** Como `ask`, pero en una consola no muestra lo que se escribe. */
  askHidden: (question: string) => Promise<string>;
  close: () => void;
};

/**
 * Entrada redirigida (un script): un solo lector para todas las líneas. Con
 * un `readline` por pregunta, las líneas que llegan antes se perderían.
 */
function pipedPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string) => {
    process.stdout.write(question);
    const next = await lines.next();
    if (next.done === true) throw new Error('Se terminó la entrada antes de completar los datos.');
    process.stdout.write('\n');
    return next.value;
  };
  return {
    ask,
    askHidden: ask,
    close: () => {
      rl.close();
    },
  };
}

/** Consola: preguntas normales con readline y la contraseña en modo crudo (sin eco). */
function consolePrompter(): Prompter {
  return {
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    askHidden: readHidden,
    close: () => undefined,
  };
}

/** Lee una línea de la consola sin mostrar lo que se escribe. */
function readHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const config = loadConfig(resolveEnvFilePath(repoRoot));
  const dbPath = path.join(config.paths.data, 'sti-catcher.db');
  const db = openDatabase(dbPath);
  migrate(db, migrations);
  const users = createUsersRepository(db);
  const quiet = { info: () => undefined, warn: () => undefined };
  const auth = createAuthService({
    users,
    sessions: createSessionsRepository(db),
    limiter: createLoginLimiter(),
    logger: quiet,
  });

  console.log(`\nCrear una cuenta de administrador en ${dbPath}\n`);
  const prompt = process.stdin.isTTY ? consolePrompter() : pipedPrompter();
  let email: string;
  let name: string;
  let password: string;
  try {
    for (;;) {
      const parsed = emailSchema.safeParse(await prompt.ask('Mail: '));
      if (!parsed.success) {
        console.log('  Ese mail no es válido.');
        continue;
      }
      if (users.findByEmail(parsed.data)) {
        console.log('  Ya hay una cuenta con ese mail.');
        continue;
      }
      email = parsed.data;
      break;
    }
    for (;;) {
      name = (await prompt.ask('Nombre (como se va a ver en el historial): ')).trim();
      if (name.length > 0 && name.length <= 80) break;
      console.log('  Escribí un nombre de hasta 80 caracteres.');
    }
    for (;;) {
      password = await prompt.askHidden('Contraseña: ');
      try {
        assertPasswordStrength(password);
      } catch (error) {
        if (error instanceof AuthError) {
          console.log(`  ${error.message}`);
          continue;
        }
        throw error;
      }
      if ((await prompt.askHidden('Repetila: ')) === password) break;
      console.log('  No coinciden. Probá de nuevo.');
    }
  } finally {
    prompt.close();
  }

  const user = await auth.createUser({ email, name, role: 'admin', password });
  db.close();
  console.log(`\nListo: ${user.name} <${user.email}> ya puede ingresar como administrador.\n`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof AuthError) {
    console.error(`\n[STI-Catcher] ${error.message}\n`);
  } else {
    console.error('[STI-Catcher] No se pudo crear la cuenta:', error);
  }
  process.exit(1);
});
