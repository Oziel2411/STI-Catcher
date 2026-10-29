import { ApiClientError } from './client.ts';

/** Envía el fragmento `seq`. Lanza ApiClientError si el server responde con error. */
export type SendChunk = (seq: number, blob: Blob) => Promise<void>;

export type UploaderState = {
  /** Fragmentos esperando o enviándose. */
  pending: number;
  uploadedBytes: number;
  /** Reintentos en curso (red inestable). */
  retrying: boolean;
  /** Error definitivo: no se siguen enviando fragmentos. */
  error: string | null;
};

export type ChunkUploaderOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  onChange?: (state: UploaderState) => void;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Errores con los que reintentar no sirve: la sesión no existe, es de otro
 * navegador, ya terminó, falta un fragmento anterior, o no hay disco.
 * Los demás (red caída, 5xx, fragmento cortado) se reintentan.
 */
const FATAL_STATUS = new Set([403, 404, 409, 413, 507]);

const isFatal = (error: unknown) =>
  error instanceof ApiClientError && error.status !== null && FATAL_STATUS.has(error.status);

/**
 * Sube los fragmentos de MediaRecorder de a uno y en orden (SPEC §6): el
 * server los agrega al archivo en el orden en que llegan. Si uno falla por
 * la red, se reintenta el mismo número (el server ignora los repetidos) con
 * espera creciente; los siguientes esperan su turno.
 */
export class ChunkUploader {
  private readonly queue: { seq: number; blob: Blob }[] = [];
  private nextSeq = 0;
  private running = false;
  private state: UploaderState = { pending: 0, uploadedBytes: 0, retrying: false, error: null };
  private drainWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly send: SendChunk,
    private readonly options: ChunkUploaderOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get snapshot(): UploaderState {
    return this.state;
  }

  push(blob: Blob): void {
    if (this.state.error !== null || blob.size === 0) return;
    this.queue.push({ seq: this.nextSeq++, blob });
    this.update({ pending: this.queue.length });
    void this.run();
  }

  /** Resuelve cuando no queda nada por enviar; rechaza si hubo un error definitivo. */
  drain(): Promise<void> {
    if (this.state.error !== null) return Promise.reject(new Error(this.state.error));
    if (this.queue.length === 0 && !this.running) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.drainWaiters.push({ resolve, reject });
    });
  }

  private update(changes: Partial<UploaderState>) {
    this.state = { ...this.state, ...changes };
    this.options.onChange?.(this.state);
  }

  private settleWaiters() {
    const waiters = this.drainWaiters.splice(0);
    for (const waiter of waiters) {
      if (this.state.error !== null) waiter.reject(new Error(this.state.error));
      else waiter.resolve();
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let item = this.queue[0]; item !== undefined; item = this.queue[0]) {
        await this.sendWithRetries(item.seq, item.blob);
        this.queue.shift();
        this.update({
          pending: this.queue.length,
          uploadedBytes: this.state.uploadedBytes + item.blob.size,
          retrying: false,
        });
      }
    } catch (error) {
      this.queue.length = 0;
      this.update({
        pending: 0,
        retrying: false,
        error: error instanceof Error ? error.message : 'No se pudo subir la grabación.',
      });
    } finally {
      this.running = false;
      this.settleWaiters();
    }
  }

  private async sendWithRetries(seq: number, blob: Blob): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.send(seq, blob);
        return;
      } catch (error) {
        if (isFatal(error) || attempt >= this.maxAttempts) throw error;
        this.update({ retrying: true });
        // 1 s, 2 s, 4 s, 8 s… como mucho 15 s.
        await this.sleep(Math.min(15_000, this.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
}
