// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Procesos hijos: solo spawn/execFile con array de argumentos (SPEC §10).
 * exec/execSync pasan por una shell y permiten inyección de comandos.
 */
const forbiddenChildProcess = ['node:child_process', 'child_process'].map((name) => ({
  name,
  importNames: ['exec', 'execSync'],
  message: 'Usá spawn con un array de argumentos (SPEC §10). Nunca una shell.',
}));

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', 'bin/**', 'storage/**', 'data/**', 'logs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // `_` marca un valor descartado a propósito (p. ej. `const { a: _a, ...rest } = obj`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-restricted-imports': ['error', { paths: forbiddenChildProcess }],
    },
  },
  // Server
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  // La lógica de negocio y la cola de jobs no conocen Fastify (SPEC §11).
  {
    files: ['apps/server/src/modules/**/*.ts', 'apps/server/src/jobs/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...forbiddenChildProcess,
            { name: 'fastify', message: 'modules/ no conoce Fastify: eso va en routes/.' },
          ],
          patterns: [
            {
              group: ['@fastify/*', '**/routes/**'],
              message: 'modules/ no conoce Fastify: eso va en routes/.',
            },
          ],
        },
      ],
    },
  },
  // Web
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // Archivos de configuración en JS: sin chequeo de tipos.
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
