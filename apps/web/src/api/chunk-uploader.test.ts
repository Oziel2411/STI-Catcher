import { describe, expect, it, vi } from 'vitest';
import { ChunkUploader } from './chunk-uploader.ts';
import { ApiClientError } from './client.ts';

const blob = (size: number) => new Blob([new Uint8Array(size)]);
const noSleep = () => Promise.resolve();

describe('ChunkUploader', () => {
  it('envía los fragmentos de a uno y en orden, numerados desde 0', async () => {
    const sent: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const uploader = new ChunkUploader(async (seq) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      sent.push(seq);
      inFlight--;
    });
    uploader.push(blob(10));
    uploader.push(blob(20));
    uploader.push(blob(30));
    await uploader.drain();
    expect(sent).toEqual([0, 1, 2]);
    expect(maxInFlight).toBe(1);
    expect(uploader.snapshot).toMatchObject({ pending: 0, uploadedBytes: 60, error: null });
  });

  it('reintenta el mismo fragmento ante un corte de red, y los siguientes esperan', async () => {
    const attempts: number[] = [];
    let failures = 2;
    const uploader = new ChunkUploader(
      (seq) => {
        attempts.push(seq);
        if (seq === 0 && failures-- > 0) {
          return Promise.reject(new ApiClientError('Sin conexión', 'NETWORK_ERROR', null));
        }
        return Promise.resolve();
      },
      { sleep: noSleep },
    );
    uploader.push(blob(1));
    uploader.push(blob(1));
    await uploader.drain();
    expect(attempts).toEqual([0, 0, 0, 1]);
  });

  it('no reintenta errores definitivos (p. ej. sin espacio en disco) y avisa', async () => {
    const send = vi.fn(() =>
      Promise.reject(new ApiClientError('No hay espacio suficiente…', 'INSUFFICIENT_DISK', 507)),
    );
    const onChange = vi.fn();
    const uploader = new ChunkUploader(send, { sleep: noSleep, onChange });
    uploader.push(blob(1));
    uploader.push(blob(1));
    await expect(uploader.drain()).rejects.toThrow('No hay espacio suficiente…');
    expect(send).toHaveBeenCalledTimes(1);
    expect(uploader.snapshot.error).toBe('No hay espacio suficiente…');
    // Después de un error no se aceptan más fragmentos.
    uploader.push(blob(1));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('se rinde después de varios intentos fallidos', async () => {
    const send = vi.fn(() => Promise.reject(new ApiClientError('500', 'HTTP_ERROR', 500)));
    const uploader = new ChunkUploader(send, { sleep: noSleep, maxAttempts: 3 });
    uploader.push(blob(1));
    await expect(uploader.drain()).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('ignora fragmentos vacíos (MediaRecorder a veces los entrega)', async () => {
    const send = vi.fn(() => Promise.resolve());
    const uploader = new ChunkUploader(send);
    uploader.push(blob(0));
    await uploader.drain();
    expect(send).not.toHaveBeenCalled();
  });
});
