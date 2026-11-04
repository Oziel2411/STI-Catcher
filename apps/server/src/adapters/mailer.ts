import nodemailer from 'nodemailer';

export type MailMessage = { to: string[]; subject: string; text: string };

/** Manda un mail. Lanza MailError con un mensaje para el usuario si falla. */
export type SendMail = (message: MailMessage) => Promise<void>;

export type SmtpSettings = {
  host: string;
  port: number;
  /** true: TLS desde el principio (465). false: STARTTLS si el server lo ofrece (587). */
  secure: boolean;
  auth: { user: string; password: string } | null;
  from: string;
};

export class MailError extends Error {
  override name = 'MailError';
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Error de nodemailer → mensaje en español, sin datos de la cuenta. */
export function describeMailError(error: unknown): MailError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN';
  const messages: Record<string, string> = {
    EAUTH: 'El servidor de correo rechazó el usuario o la contraseña (SMTP_USER / SMTP_PASSWORD).',
    ECONNECTION:
      'No se pudo conectar con el servidor de correo. Revisá SMTP_HOST, SMTP_PORT y SMTP_SECURITY.',
    ETIMEDOUT: 'El servidor de correo no respondió a tiempo. Revisá SMTP_HOST y SMTP_PORT.',
    ESOCKET:
      'Se cortó la conexión con el servidor de correo. Si usa SSL, el puerto suele ser 465; con STARTTLS, 587.',
    EDNS: 'No se encontró el servidor de correo (SMTP_HOST).',
    ETLS: 'Falló la conexión segura con el servidor de correo. Revisá SMTP_SECURITY y SMTP_PORT.',
    EENVELOPE:
      'El servidor de correo rechazó el remitente o algún destinatario (MAIL_FROM / MAIL_TO).',
    EMESSAGE: 'El servidor de correo rechazó el mensaje.',
  };
  return new MailError(
    code,
    messages[code] ?? 'No se pudo enviar el mail. El detalle quedó en el log del servidor.',
    { cause: error },
  );
}

/**
 * Envío por SMTP (D-099). Una conexión por mail: son pocos (uno por
 * grabación) y así un corte de red no deja una conexión colgada.
 */
export function createSmtpMailer(settings: SmtpSettings): SendMail {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure,
    ...(settings.auth ? { auth: { user: settings.auth.user, pass: settings.auth.password } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return async (message) => {
    try {
      await transport.sendMail({
        from: { name: 'STI-Catcher', address: settings.from },
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch (error) {
      throw describeMailError(error);
    }
  };
}
