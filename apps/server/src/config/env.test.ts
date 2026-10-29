import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, resolveEnvFilePath } from './env.ts';

const BASE = 'D:\\apps\\sti';

const minimal = {
  STORAGE_DIR: './storage',
  DATA_DIR: './data',
  LOG_DIR: './logs',
  BIN_DIR: './bin',
};

const errorOf = (fn: () => unknown): ConfigError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('Se esperaba un ConfigError');
};

describe('parseConfig', () => {
  it('aplica los defaults de la spec', () => {
    const config = parseConfig(minimal, BASE);
    expect(config.server).toEqual({ host: '127.0.0.1', port: 3000, https: null });
    expect(config.limits).toEqual({
      maxConcurrentJobs: 2,
      maxUploadBytes: 2048 * 1024 ** 2,
      retentionDays: 14,
      minFreeDiskBytes: 5 * 1024 ** 3,
    });
    expect(config.nodeEnv).toBe('development');
  });

  it('resuelve rutas relativas contra la carpeta del .env, no contra el cwd', () => {
    const config = parseConfig(minimal, BASE);
    expect(config.paths.storage).toBe(path.resolve(BASE, 'storage'));
    expect(config.paths.bin).toBe(path.resolve(BASE, 'bin'));
  });

  it('deriva las herramientas de BIN_DIR, y deno siempre de BIN_DIR', () => {
    const config = parseConfig({ ...minimal, YTDLP_PATH: 'C:\\tools\\yt-dlp.exe' }, BASE);
    expect(config.tools.ytdlp).toBe('C:\\tools\\yt-dlp.exe');
    expect(config.tools.ffmpeg).toBe(path.join(BASE, 'bin', 'ffmpeg.exe'));
    expect(config.tools.deno).toBe(path.join(BASE, 'bin', 'deno.exe'));
  });

  it('trata variables vacías como no definidas', () => {
    const config = parseConfig({ ...minimal, HTTPS_CERT_PATH: '', HTTPS_KEY_PATH: '  ' }, BASE);
    expect(config.server.https).toBeNull();
  });

  it('falla si falta una ruta obligatoria, nombrando la variable', () => {
    const { STORAGE_DIR: _omit, ...rest } = minimal;
    expect(errorOf(() => parseConfig(rest, BASE)).message).toContain('STORAGE_DIR');
  });

  it('falla con números fuera de rango o no numéricos', () => {
    expect(errorOf(() => parseConfig({ ...minimal, PORT: '70000' }, BASE)).message).toContain(
      'PORT',
    );
    expect(
      errorOf(() => parseConfig({ ...minimal, MAX_CONCURRENT_JOBS: 'dos' }, BASE)).message,
    ).toContain('MAX_CONCURRENT_JOBS');
  });

  it('descarga: sin extractor generic y con bloqueo de IPs privadas por defecto', () => {
    expect(parseConfig(minimal, BASE).download).toEqual({
      ytdlpExtractors: 'default,-generic',
      blockPrivateUrls: true,
    });
    const custom = parseConfig(
      { ...minimal, YTDLP_EXTRACTORS: 'youtube,instagram', BLOCK_PRIVATE_URLS: 'false' },
      BASE,
    );
    expect(custom.download).toEqual({
      ytdlpExtractors: 'youtube,instagram',
      blockPrivateUrls: false,
    });
  });

  it('rechaza extractores con caracteres raros y booleanos inválidos', () => {
    expect(
      errorOf(() => parseConfig({ ...minimal, YTDLP_EXTRACTORS: 'default; rm -rf' }, BASE)).message,
    ).toContain('YTDLP_EXTRACTORS');
    expect(
      errorOf(() => parseConfig({ ...minimal, BLOCK_PRIVATE_URLS: 'quizás' }, BASE)).message,
    ).toContain('BLOCK_PRIVATE_URLS');
  });

  it('exige certificado y clave juntos', () => {
    const error = errorOf(() =>
      parseConfig({ ...minimal, HOST: '0.0.0.0', HTTPS_CERT_PATH: './cert.pem' }, BASE),
    );
    expect(error.message).toContain('HTTPS_KEY_PATH');
  });

  it('no permite HTTP sin cifrar fuera de localhost', () => {
    const error = errorOf(() => parseConfig({ ...minimal, HOST: '0.0.0.0' }, BASE));
    expect(error.message).toContain('HOST');
  });

  it('permite cualquier HOST con HTTPS configurado', () => {
    const config = parseConfig(
      { ...minimal, HOST: '0.0.0.0', HTTPS_CERT_PATH: 'c.pem', HTTPS_KEY_PATH: 'k.pem' },
      BASE,
    );
    expect(config.server.https).toEqual({
      certPath: path.resolve(BASE, 'c.pem'),
      keyPath: path.resolve(BASE, 'k.pem'),
    });
  });
});

describe('resolveEnvFilePath', () => {
  it('usa <repo>/.env por defecto', () => {
    expect(resolveEnvFilePath(BASE, {})).toBe(path.join(BASE, '.env'));
  });

  it('respeta STI_ENV_FILE', () => {
    expect(resolveEnvFilePath(BASE, { STI_ENV_FILE: 'E:\\sti\\.env' })).toBe('E:\\sti\\.env');
  });
});
