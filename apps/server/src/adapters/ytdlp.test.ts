import { describe, expect, it, vi } from 'vitest';
import { fixtureLines, readFixture, readJsonFixture } from '../../test/fixtures.ts';
import type { CommandRunner, StreamingRunner } from './process.ts';
import {
  buildDownloadArgs,
  buildProbeArgs,
  classifyYtdlpError,
  codecFamily,
  createYtdlp,
  createYtdlpProgressTracker,
  mapProbeOutput,
  outputTemplate,
  selectFormat,
  YtdlpError,
} from './ytdlp.ts';
import type { YtdlpProgressUpdate } from './ytdlp.ts';

const base = {
  extractors: 'default,-generic',
  denoPath: 'D:\\sti\\bin\\deno.exe',
  cacheDir: 'D:\\sti\\data\\cache\\yt-dlp',
};

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('buildProbeArgs', () => {
  it('pide JSON de un solo video, con la URL después de "--"', () => {
    const args = buildProbeArgs('https://youtu.be/x', base);
    expect(args).toContain('-J');
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--ignore-config');
    expect(args.slice(-2)).toEqual(['--', 'https://youtu.be/x']);
  });

  it('pasa Deno, la caché y los extractores', () => {
    const args = buildProbeArgs('https://youtu.be/x', base);
    expect(valueAfter(args, '--js-runtimes')).toBe('deno:D:\\sti\\bin\\deno.exe');
    expect(valueAfter(args, '--cache-dir')).toBe('D:\\sti\\data\\cache\\yt-dlp');
    // En un solo argumento: un valor que empiece con "-" no se lee como otra opción.
    expect(args).toContain('--use-extractors=default,-generic');
  });

  it('una URL que empieza con "-" queda como URL, no como opción', () => {
    const args = buildProbeArgs('-o C:\\evil', base);
    expect(args.indexOf('-o C:\\evil')).toBe(args.indexOf('--') + 1);
  });
});

describe('selectFormat', () => {
  it('compat: prefiere H.264 y no supera la altura elegida', () => {
    expect(selectFormat('mp4', 1080, 'compat')).toEqual({
      format: 'bv[height<=1080]+ba/b[height<=1080]/bv+ba/b',
      sort: 'vcodec:h264,res:1080,channels:2,acodec:aac',
      extra: ['--merge-output-format', 'mp4', '--remux-video', 'mp4'],
    });
  });

  it('quality: sin preferencia de codec de video', () => {
    expect(selectFormat('mp4', 2160, 'quality').sort).toBe('res:2160,acodec:aac');
  });

  it('recode baja igual que quality (la recodificación la hace ffmpeg después)', () => {
    expect(selectFormat('mp4', 720, 'recode')).toEqual(selectFormat('mp4', 720, 'quality'));
  });

  it('estéreo salvo en máxima calidad (medido: si no, elegía AAC 5.1 de 384 kbps)', () => {
    expect(selectFormat('mp3', null, 'compat').sort).toBe('channels:2,acodec:aac');
    expect(selectFormat('m4a', null, 'compat').sort).toBe('channels:2,acodec:aac');
    expect(selectFormat('mp4', 360, 'compat').sort).toContain('channels:2');
    expect(selectFormat('mp4', 360, 'quality').sort).not.toContain('channels');
  });

  it('sin altura: la mejor disponible', () => {
    const selection = selectFormat('mp4', null, 'compat');
    expect(selection.format).toBe('bv+ba/b');
    expect(selection.sort).toBe('vcodec:h264,channels:2,acodec:aac');
  });

  it('audio: extrae a MP3 o M4A e ignora altura y modo', () => {
    expect(selectFormat('mp3', 1080, 'recode').extra).toEqual([
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
    ]);
    expect(selectFormat('m4a', null, 'compat').format).toBe('ba[acodec^=mp4a]/ba/b');
  });
});

describe('buildDownloadArgs', () => {
  const args = buildDownloadArgs({
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    format: 'mp4',
    maxHeight: 360,
    mode: 'compat',
    outputTemplate: outputTemplate('D:\\sti\\storage\\tmp', 'abc'),
    ffmpegPath: 'D:\\sti\\bin\\ffmpeg.exe',
    base,
  });

  it('incluye progreso parseable, el formato y ffmpeg', () => {
    expect(args).toContain('--newline');
    expect(args).toContain('--no-simulate');
    expect(valueAfter(args, '-f')).toBe('bv[height<=360]+ba/b[height<=360]/bv+ba/b');
    expect(valueAfter(args, '-S')).toBe('vcodec:h264,res:360,channels:2,acodec:aac');
    expect(valueAfter(args, '--ffmpeg-location')).toBe('D:\\sti\\bin\\ffmpeg.exe');
  });

  it('nombra el archivo con el id del job, nunca con el título', () => {
    expect(valueAfter(args, '-o')).toBe('D:\\sti\\storage\\tmp\\abc.%(ext)s');
  });

  it('termina con "--" y la URL', () => {
    expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
  });
});

describe('codecFamily', () => {
  it.each([
    ['avc1.4D401F', 'h264'],
    ['avc1.42001E', 'h264'],
    ['vp09.00.10.08', 'vp9'],
    ['vp9', 'vp9'],
    ['av01.0.08M.08', 'av1'],
    ['hev1.1.6.L93.B0', 'h265'],
    ['theora', 'other'],
  ])('%s → %s', (input, expected) => {
    expect(codecFamily(input)).toBe(expected);
  });
});

describe('mapProbeOutput (salidas reales de yt-dlp -J)', () => {
  it('Big Buck Bunny: H.264 hasta 1080p; 1440p y 2160p solo VP9/AV1', () => {
    const probe = mapProbeOutput(
      readJsonFixture('ytdlp-probe-big-buck-bunny.json'),
      'https://youtu.be/aqz-KE-bpKQ',
    );
    expect(probe).toMatchObject({
      url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film',
      site: 'Youtube',
      uploader: 'Blender',
      durationSeconds: 635,
      isLive: false,
      hasVideo: true,
      hasAudio: true,
      maxH264Height: 1080,
    });
    expect(probe.thumbnailUrl).toMatch(/^https:\/\//);
    expect(probe.resolutions.map((r) => r.height)).toEqual([
      2160, 1440, 1080, 720, 480, 360, 240, 144,
    ]);
    expect(probe.resolutions[0]).toEqual({ height: 2160, codecs: ['vp9', 'av1'] });
    expect(probe.resolutions[2]).toEqual({ height: 1080, codecs: ['h264', 'vp9', 'av1'] });
  });

  it('ignora storyboards (mhtml) y formatos sin codec', () => {
    const probe = mapProbeOutput(readJsonFixture('ytdlp-probe-big-buck-bunny.json'), 'x');
    expect(probe.resolutions.some((r) => r.height === 27)).toBe(false);
  });

  it('Me at the zoo: H.264 solo hasta 240p', () => {
    const probe = mapProbeOutput(readJsonFixture('ytdlp-probe-me-at-the-zoo.json'), 'x');
    expect(probe.maxH264Height).toBe(240);
    expect(probe.resolutions).toEqual([
      { height: 240, codecs: ['h264', 'vp9', 'av1'] },
      { height: 144, codecs: ['h264', 'vp9'] },
    ]);
  });

  it('sitio sin lista de formatos: usa los datos del propio video', () => {
    const probe = mapProbeOutput(
      {
        title: 'Clip',
        vcodec: 'avc1.64001F',
        acodec: 'mp4a.40.2',
        height: 720,
        extractor_key: 'Twitter',
      },
      'https://x.com/a/status/1',
    );
    expect(probe.resolutions).toEqual([{ height: 720, codecs: ['h264'] }]);
    expect(probe.url).toBe('https://x.com/a/status/1');
  });

  it('rechaza playlists', () => {
    expect(() => mapProbeOutput({ _type: 'playlist', entries: [] }, 'x')).toThrow('playlist');
  });
});

describe('createYtdlpProgressTracker (salidas reales de descargas)', () => {
  /** Reproduce un fixture y devuelve info y actualizaciones en orden. */
  function replay(mode: 'compat' | 'quality' | 'mp3') {
    const tracker = createYtdlpProgressTracker();
    const lines = [
      ...fixtureLines(`ytdlp-download-${mode}.stdout.txt`),
      ...fixtureLines(`ytdlp-download-${mode}.stderr.txt`),
    ];
    const updates: YtdlpProgressUpdate[] = [];
    let info = null;
    for (const line of lines) {
      info = tracker.parseInfo(line) ?? info;
      const update = tracker.push(line);
      if (update) updates.push(update);
    }
    return { info, updates };
  }

  it('lee el título y el formato elegido', () => {
    expect(replay('compat').info).toEqual({
      title: 'Me at the zoo',
      durationSeconds: 19,
      site: 'Youtube',
      webpageUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      formatId: '133+140',
    });
  });

  it('video + audio: el video pesa 90 % y el total llega a 100 % antes de unir', () => {
    const { updates } = replay('compat');
    const downloads = updates.filter((u) => u.phase === 'downloading').map((u) => u.percent);
    expect(downloads[0]).toBeCloseTo((1024 / 433081) * 90, 1);
    expect(downloads[1]).toBeCloseTo(90);
    expect(downloads.at(-1)).toBe(100);
    // Nunca retrocede.
    for (let i = 1; i < downloads.length; i++) {
      expect(downloads[i] ?? 0).toBeGreaterThanOrEqual(downloads[i - 1] ?? 0);
    }
    expect(updates.map((u) => u.phase)).toContain('merging');
  });

  it('informa velocidad y ETA cuando yt-dlp las da (NA → null)', () => {
    const { updates } = replay('compat');
    expect(updates[0]).toMatchObject({ speedBytesPerSecond: 642094.0792345642, etaSeconds: 0 });
    const quality = replay('quality').updates[0];
    expect(quality).toMatchObject({ speedBytesPerSecond: null, etaSeconds: null });
  });

  it('MP3: un solo stream y fase de conversión', () => {
    const { info, updates } = replay('mp3');
    expect(info?.formatId).toBe('140');
    expect(updates.filter((u) => u.phase === 'downloading').at(-1)?.percent).toBe(100);
    expect(updates.map((u) => u.phase)).toContain('converting');
  });

  it('ignora líneas que no son de progreso', () => {
    const tracker = createYtdlpProgressTracker();
    expect(tracker.push('[youtube] Extracting URL: https://...')).toBeNull();
    expect(tracker.parseInfo('STI_INFO {roto')).toBeNull();
  });
});

describe('classifyYtdlpError', () => {
  it.each([
    // Salidas reales (fixtures).
    [readFixture('ytdlp-error-unavailable.txt'), 'UNAVAILABLE'],
    [readFixture('ytdlp-error-unsupported.txt'), 'UNSUPPORTED_SITE'],
    [readFixture('ytdlp-error-truncated-id.txt'), 'INVALID_URL'],
    // Textos exactos que arman yt-dlp y YouTube (no reproducibles a pedido).
    [
      "ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication.",
      'PRIVATE',
    ],
    [
      'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication.',
      'AGE_RESTRICTED',
    ],
    [
      'ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
      'BOT_CHECK',
    ],
    [
      'ERROR: [youtube] abc: The uploader has not made this video available in your country',
      'GEO_RESTRICTED',
    ],
    [
      "ERROR: [youtube] abc: This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.",
      'RATE_LIMITED',
    ],
    ['ERROR: [youtube] abc: This video is DRM protected', 'DRM'],
    ['ERROR: [youtube] abc: This live event will begin in 3 hours.', 'LIVE'],
    [
      'ERROR: [youtube] abc: Join this channel to get access to members-only content like this video',
      'LOGIN_REQUIRED',
    ],
    [
      'ERROR: [youtube] abc: nsig extraction failed: Some formats may be missing; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U',
      'OUTDATED',
    ],
    [
      'ERROR: Requested format is not available. Use --list-formats for a list of available formats',
      'FORMAT_UNAVAILABLE',
    ],
    [
      'ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>',
      'NETWORK',
    ],
  ])('%#: %s', (text, code) => {
    expect(classifyYtdlpError(text.split('\n')).code).toBe(code);
  });

  it('las líneas ERROR: tienen prioridad sobre las advertencias', () => {
    expect(
      classifyYtdlpError([
        'WARNING: [youtube] Sign in to see more formats',
        'ERROR: [youtube] abc: This video is unavailable',
      ]).code,
    ).toBe('UNAVAILABLE');
  });

  it('el aviso de desactualizado sugiere el script de actualización', () => {
    expect(classifyYtdlpError(['ERROR: nsig extraction failed']).message).toContain(
      'update-ytdlp.ps1',
    );
  });

  it('error desconocido: mensaje genérico', () => {
    expect(classifyYtdlpError(['ERROR: algo raro'])).toEqual({
      code: 'UNKNOWN',
      message: expect.stringContaining('log del servidor') as string,
    });
  });
});

describe('createYtdlp', () => {
  const deps = (runCommand: CommandRunner, runStreaming: StreamingRunner = vi.fn()) =>
    createYtdlp({
      runCommand,
      runStreaming,
      ytdlpPath: 'yt-dlp.exe',
      ffmpegPath: 'ffmpeg.exe',
      base,
      denoDir: 'D:\\sti\\data\\cache\\deno',
    });

  it('probe: parsea el JSON y pasa DENO_DIR y UTF-8 al proceso', async () => {
    const runCommand = vi.fn<CommandRunner>(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: readFixture('ytdlp-probe-me-at-the-zoo.json'),
        stderr: '',
        timedOut: false,
      }),
    );
    const probe = await deps(runCommand).probe('https://youtu.be/jNQXAC9IVRw');
    expect(probe.title).toBe('Me at the zoo');
    const env = runCommand.mock.calls[0]?.[2].env;
    expect(env).toMatchObject({
      DENO_DIR: 'D:\\sti\\data\\cache\\deno',
      PYTHONIOENCODING: 'utf-8',
    });
  });

  it('probe: un error de yt-dlp llega traducido', async () => {
    const runCommand: CommandRunner = () =>
      Promise.resolve({
        exitCode: 1,
        stdout: '',
        stderr: readFixture('ytdlp-error-unavailable.txt'),
        timedOut: false,
      });
    const error = await deps(runCommand)
      .probe('https://youtu.be/aaaaaaaaaaa')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YtdlpError);
    expect((error as YtdlpError).info.message).toBe('El video no existe o fue eliminado.');
  });

  it('download: lee stdout y stderr, informa título y progreso', async () => {
    const runStreaming = vi.fn<StreamingRunner>((_file, _args, options) => {
      for (const line of fixtureLines('ytdlp-download-compat.stdout.txt'))
        options.onStdoutLine?.(line);
      for (const line of fixtureLines('ytdlp-download-compat.stderr.txt'))
        options.onStderrLine?.(line);
      return Promise.resolve({ exitCode: 0, stderrTail: [] });
    });
    const onInfo = vi.fn();
    const onProgress = vi.fn();
    await deps(vi.fn(), runStreaming).download({
      url: 'https://youtu.be/jNQXAC9IVRw',
      format: 'mp4',
      maxHeight: 360,
      mode: 'compat',
      outputTemplate: 'x',
      signal: new AbortController().signal,
      onInfo,
      onProgress,
    });
    expect(onInfo).toHaveBeenCalledWith(expect.objectContaining({ title: 'Me at the zoo' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'merging' }));
  });
});
