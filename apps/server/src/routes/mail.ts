import type { FastifyInstance } from 'fastify';
import { MailError } from '../adapters/mailer.ts';
import { HttpError } from '../http/validation.ts';
import { MailServiceError } from '../modules/notifications/mail-service.ts';
import type { MailService } from '../modules/notifications/mail-service.ts';

export function registerMailRoutes(
  app: FastifyInstance,
  mail: MailService,
  logger: { warn: (obj: object, msg: string) => void },
): void {
  app.get('/api/mail', () => mail.status());

  // Manda un mail de prueba a MAIL_TO (página Estado).
  app.post('/api/mail/test', async () => {
    try {
      return await mail.sendTest();
    } catch (error) {
      if (error instanceof MailServiceError) {
        throw new HttpError(error.status, error.code, error.message);
      }
      if (error instanceof MailError) {
        logger.warn({ code: error.code, err: error.cause }, 'Falló el mail de prueba');
        throw new HttpError(502, `MAIL_${error.code}`, error.message);
      }
      throw error;
    }
  });
}
