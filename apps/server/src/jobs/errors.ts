/**
 * Error con un mensaje apto para el usuario. Los runners lo lanzan cuando
 * saben qué pasó (p. ej. "El video es privado"). Cualquier otro error se
 * guarda en el job con un mensaje genérico y el detalle va al log.
 */
export class JobError extends Error {
  override name = 'JobError';
}

/** El job no se puede crear (p. ej. no hay espacio en disco). */
export class JobRejectedError extends Error {
  override name = 'JobRejectedError';
  constructor(
    readonly code: 'INSUFFICIENT_DISK' | 'NO_RUNNER',
    message: string,
  ) {
    super(message);
  }
}

/** Motivo de un abort: lo pidió el usuario, o el server se está deteniendo. */
export class JobAbort extends Error {
  override name = 'JobAbort';
  constructor(readonly reason: 'cancel' | 'shutdown') {
    super(reason === 'cancel' ? 'Cancelado por el usuario' : 'Servidor detenido');
  }
}

export const INTERRUPTED_MESSAGE = 'Interrumpido por un reinicio del servidor.';
export const UNEXPECTED_MESSAGE =
  'Ocurrió un error inesperado. El detalle quedó en el log del servidor.';
