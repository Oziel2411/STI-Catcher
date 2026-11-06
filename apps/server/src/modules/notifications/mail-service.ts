import type { MailStatusResponse } from '@sti-catcher/shared';
import type { SendMail } from '../../adapters/mailer.ts';
import { mailDateTime } from './job-notice.ts';

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
  now?: () => Date;
};

/** Estado del mail y envío de prueba a quien lo pide (página Estado, D-099 y D-104). */
export function createMailService(deps: MailServiceDeps) {
  const now = deps.now ?? (() => new Date());
  let sending = false;

  return {
    status(): MailStatusResponse {
      return { configured: deps.send !== null, from: deps.from };
    },

    /** Manda un mail de prueba a la cuenta que lo pide. Lanza MailError si el servidor falla. */
    async sendTest(to: { email: string; name: string }): Promise<{ sentTo: string }> {
      if (deps.send === null) {
        throw new MailServiceError(
          'MAIL_NOT_CONFIGURED',
          'El mail no está configurado: faltan SMTP_HOST y los datos de la casilla en el .env del servidor.',
          409,
        );
      }
      if (sending) {
        throw new MailServiceError('MAIL_BUSY', 'Ya se está mandando un mail de prueba.', 429);
      }
      sending = true;
      try {
        await deps.send({
          to: [to.email],
          subject: 'STI-Catcher: mail de prueba',
          text: [
            `Hola, ${to.name}:`,
            '',
            'Este es un mail de prueba de STI-Catcher. Si te llegó, los avisos que pidas',
            '(o que te pidan tus compañeros) al grabar, descargar o convertir te van a llegar acá.',
            '',
            `Enviado: ${mailDateTime(now().toISOString()) ?? ''}`,
          ].join('\n'),
        });
        return { sentTo: to.email };
      } finally {
        sending = false;
      }
    },
  };
}

export type MailService = ReturnType<typeof createMailService>;
