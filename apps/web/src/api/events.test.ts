import type { JobEvent } from '@sti-catcher/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeToJobEvents } from './events.ts';
import type { EventSourceLike } from './events.ts';

/** EventSource falso: guarda listeners y permite simular eventos. */
class FakeSource extends EventTarget implements EventSourceLike {
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  fail(permanently: boolean) {
    if (permanently) this.readyState = 2;
    this.dispatchEvent(new Event('error'));
  }
}

const JOB_ID = '00000000-0000-4000-8000-00000000000a';
const progressEvent: JobEvent = {
  type: 'job.progress',
  jobId: JOB_ID,
  progress: {
    phase: 'processing',
    percent: 5,
    speedBytesPerSecond: null,
    speedRatio: 1,
    etaSeconds: 1,
  },
};

function setup() {
  const sources: FakeSource[] = [];
  const onEvent = vi.fn();
  const onConnectionChange = vi.fn();
  const close = subscribeToJobEvents(
    JOB_ID,
    { onEvent, onConnectionChange },
    {
      retryMs: 1000,
      staleAfterMs: 10_000,
      createSource: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
    },
  );
  return { sources, onEvent, onConnectionChange, close };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('subscribeToJobEvents', () => {
  it('se conecta al stream del job y entrega eventos válidos', () => {
    const { sources, onEvent } = setup();
    expect(sources[0]?.url).toBe(`/api/jobs/${JOB_ID}/events`);
    sources[0]?.emit('job.progress', progressEvent);
    sources[0]?.emit('job.progress', { basura: true });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(progressEvent);
  });

  it('si el navegador cierra la conexión (p. ej. 502), reconecta después de retryMs', () => {
    vi.useFakeTimers();
    const { sources, onConnectionChange } = setup();
    sources[0]?.fail(true);
    expect(onConnectionChange).toHaveBeenCalledWith(false);
    expect(sources[0]?.closed).toBe(true);
    expect(sources).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
  });

  it('un error transitorio no abre otra conexión (EventSource reintenta solo)', () => {
    vi.useFakeTimers();
    const { sources } = setup();
    sources[0]?.fail(false);
    vi.advanceTimersByTime(5000);
    expect(sources).toHaveLength(1);
  });

  it('watchdog: si el server deja de mandar señales (proxy colgado), reconecta', () => {
    vi.useFakeTimers();
    const { sources, onConnectionChange } = setup();
    sources[0]?.dispatchEvent(new Event('open'));

    // Los latidos postergan el watchdog.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(8_000);
      sources[0]?.dispatchEvent(new MessageEvent('ping', { data: '{}' }));
    }
    expect(sources).toHaveLength(1);

    // Silencio total: a los 10 s se da por muerta y se abre otra.
    vi.advanceTimersByTime(10_000);
    expect(onConnectionChange).toHaveBeenLastCalledWith(false);
    expect(sources[0]?.closed).toBe(true);
    expect(sources).toHaveLength(2);
  });

  it('cerrar cancela una reconexión pendiente', () => {
    vi.useFakeTimers();
    const { sources, close } = setup();
    sources[0]?.fail(true);
    close();
    vi.advanceTimersByTime(5000);
    expect(sources).toHaveLength(1);
  });
});
