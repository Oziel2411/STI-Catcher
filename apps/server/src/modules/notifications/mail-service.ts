import type { MailStatusResponse } from '@sti-catcher/shared';
import type { SendMail } from '../../adapters/mailer.ts';
import { mailDateTime } from './recording-notice.ts';

export class MailServiceError extends Error {
  override name = 'MailServiceError';
  constructor(
    readonly code: 'MAIL_NOT_CONFIGURED' | 'MAIL_BUSY',
    message: string,
    readonly status: 409 | 429,
  ) {
    super(message);
  }
}

export type MailServiceDeps = {
  /** null sin SMTP configurado. */
  send: SendMail | null;
  from: string | null;
  to: readonly string[];
  now?: () => Date;
};

/** Estado del aviso por mail y envío de prueba (página Estado, D-099). */
export function createMailService(deps: MailServiceDeps) {
  const now = deps.now ?? (() => new Date());
  let sending = false;

  return {
    status(): MailStatusResponse {
      return { configured: deps.send !== null, from: deps.from, recipients: deps.to.length };
    },

    /** Manda un mail de prueba a los destinatarios. Lanza MailError si el servidor falla. */
    async sendTest(): Promise<{ sentTo: number }> {
      if (deps.send === null || deps.to.length === 0) {
        throw new MailServiceError(
          'MAIL_NOT_CONFIGURED',
          deps.send === null
            ? 'El mail no está configurado: faltan SMTP_HOST y los datos de la casilla en el .env del servidor.'
            : 'No hay destinatarios: completá MAIL_TO en el .env del servidor y reinicialo.',
          409,
        );
      }
      if (sending) {
        throw new MailServiceError('MAIL_BUSY', 'Ya se está mandando un mail de prueba.', 429);
      }
      sending = true;
      try {
        await deps.send({
          to: [...deps.to],
          subject: 'STI-Catcher: mail de prueba',
          text: [
            'Este es un mail de prueba de STI-Catcher.',
            '',
            'Si te llegó, los avisos de grabación terminada van a llegar a esta dirección.',
            `Enviado: ${mailDateTime(now().toISOString()) ?? ''}`,
          ].join('\n'),
        });
        return { sentTo: deps.to.length };
      } finally {
        sending = false;
      }
    },
  };
}

export type MailService = ReturnType<typeof createMailService>;
