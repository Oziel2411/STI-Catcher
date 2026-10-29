import type { JobEvent } from '@sti-catcher/shared';
import { describe, expect, it, vi } from 'vitest';
import { createJobEventBus } from './event-bus.ts';
import { formatSseEvent } from './sse.ts';

const progressEvent = (jobId: string): JobEvent => ({
  type: 'job.progress',
  jobId,
  progress: {
    phase: 'processing',
    percent: 10,
    speedBytesPerSecond: null,
    speedRatio: 1,
    etaSeconds: 9,
  },
});

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('createJobEventBus', () => {
  it('entrega todos los eventos sin filtro, y solo los pedidos con filtro', () => {
    const bus = createJobEventBus();
    const all = vi.fn();
    const onlyA = vi.fn();
    bus.subscribe(all);
    bus.subscribe(onlyA, new Set([A]));

    bus.publish(progressEvent(A));
    bus.publish(progressEvent(B));

    expect(all).toHaveBeenCalledTimes(2);
    expect(onlyA).toHaveBeenCalledTimes(1);
    expect(onlyA).toHaveBeenCalledWith(progressEvent(A));
  });

  it('desuscribir deja de entregar y libera el listener', () => {
    const bus = createJobEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();
    bus.publish(progressEvent(A));
    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount()).toBe(0);
  });

  it('un listener que lanza no afecta a los demás', () => {
    const onError = vi.fn();
    const bus = createJobEventBus(onError);
    const ok = vi.fn();
    bus.subscribe(() => {
      throw new Error('cliente desconectado');
    });
    bus.subscribe(ok);
    bus.publish(progressEvent(A));
    expect(ok).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});

describe('formatSseEvent', () => {
  it('usa el tipo como nombre de evento y el JSON en una sola línea data', () => {
    const text = formatSseEvent(progressEvent(A));
    const lines = text.split('\n');
    expect(lines[0]).toBe('event: job.progress');
    expect(lines[1]?.startsWith('data: {')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(lines[1]?.slice('data: '.length) ?? '')).toEqual(progressEvent(A));
  });
});
