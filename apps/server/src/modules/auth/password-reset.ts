import { randomBytes } from 'node:crypto';
import type { MailMessage, SendMail } from '../../adapters/mailer.ts';
import { MailError } from '../../adapters/mailer.ts';
import type { PasswordResetsRepository } from '../../db/password-resets-repository.ts';
import type { SessionsRepository } from '../../db/sessions-repository.ts';
import type { UsersRepository } from '../../db/users-repository.ts';
import type { LoginLimiter } from './login-limiter.ts';
import { hashToken } from './auth-service.ts';
import { hashPassword } from './password.ts';

/** Error con mensaje para el usuario; las rutas lo traducen al código HTTP. */
export class PasswordResetError extends Error {
  override name = 'PasswordResetError';
  constructor(
    readonly code: 'RESET_DISABLED' | 'INVALID_RESET_LINK' | 'TOO_MANY_REQUESTS',
    message: string,
    readonly status: 400 | 409 | 429,
  ) {
    super(message);
  }
}

export type PasswordResetDeps = {
  users: UsersRepository;
  sessions: SessionsRepository;
  resets: PasswordResetsRepository;
  /** null sin SMTP. */
  send: SendMail | null;
  /** Dirección pública de la app (PUBLIC_URL), sin / final. null = desactivado. */
  publicUrl: string | null;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
  now?: () => Date;
  hash?: (password: string) => Promise<string>;
  /** Si estaba bloqueada por intentos fallidos, se destraba al elegir la contraseña nueva. */
  limiter?: Pick<LoginLimiter, 'recordSuccess'>;
  /** Cuánto vale un link (D-100: 1 hora). */
  ttlMs?: number;
};

const HOUR = 60 * 60_000;
/** Pedidos por mail y por IP en una hora: frena a quien quiera llenarle la casilla a alguien. */
const MAX_PER_EMAIL = 3;
const MAX_PER_IP = 10;

const INVALID_MESSAGE =
  'El link para elegir una contraseña nueva venció o ya se usó. Pedí uno nuevo desde «¿Olvidaste tu contraseña?».';

/** El mail con el link. El token va después de `#`: el navegador no lo manda al server ni queda en sus logs. */
export function resetMessage(to: string, name: string, link: string): MailMessage {
  return {
    to: [to],
    subject: 'STI-Catcher: elegí una contraseña nueva',
    text: [
      `Hola, ${name}:`,
      '',
      'Alguien (seguramente vos) pidió elegir una contraseña nueva para tu cuenta de STI-Catcher.',
      'Para hacerlo, abrí este link (vale por 1 hora y una sola vez):',
      '',
      link,
      '',
      'Si no lo pediste, ignorá este mail: tu contraseña sigue igual.',
      '',
      'Mensaje automático de STI-Catcher. No hace falta responder.',
    ].join('\n'),
  };
}

/**
 * Recuperar la contraseña por mail (D-100, etapa 3).
 *
 * - Pedir un link responde siempre lo mismo, exista o no la cuenta, y el mail
 *   se manda en segundo plano: ni el texto ni el tiempo de respuesta dicen
 *   qué mails tienen cuenta.
 * - Un link nuevo invalida los anteriores sin usar. Usarlo cambia la
 *   contraseña, quita la marca de provisoria y corta todas las sesiones.
 */
export function createPasswordReset(deps: PasswordResetDeps) {
  const now = deps.now ?? (() => new Date());
  const hash = deps.hash ?? ((password: string) => hashPassword(password));
  const ttlMs = deps.ttlMs ?? HOUR;
  const enabled = deps.send !== null && deps.publicUrl !== null;

  // Pedidos de la última hora, por mail y por IP (en memoria: un solo proceso).
  const recent = new Map<string, number[]>();
  const allow = (key: string, max: number, at: number) => {
    const times = (recent.get(key) ?? []).filter((t) => t > at - HOUR);
    if (times.length >= max) {
      recent.set(key, times);
      return false;
    }
    recent.set(key, [...times, at]);
    return true;
  };

  return {
    enabled,

    /** Siempre termina igual si se aceptó el pedido; el mail sale en segundo plano. */
    requestReset(email: string, ip: string): void {
      if (!enabled || deps.send === null || deps.publicUrl === null) {
        throw new PasswordResetError(
          'RESET_DISABLED',
          'La recuperación por mail no está configurada. Pedile a un administrador una contraseña provisoria.',
          409,
        );
      }
      const at = now();
      if (recent.size > 1000) {
        for (const [key, times] of recent) {
          if (times.every((t) => t <= at.getTime() - HOUR)) recent.delete(key);
        }
      }
      if (
        !allow(`ip:${ip}`, MAX_PER_IP, at.getTime()) ||
        !allow(`mail:${email}`, MAX_PER_EMAIL, at.getTime())
      ) {
        throw new PasswordResetError(
          'TOO_MANY_REQUESTS',
          'Ya se pidieron varios links hace poco. Revisá tu correo (y la carpeta de spam) o probá en una hora.',
          429,
        );
      }

      const user = deps.users.findByEmail(email);
      if (!user || !user.active) {
        deps.logger.info(
          { email, ip, reason: user ? 'inactive' : 'unknown' },
          'Pedido de recuperación sin cuenta activa: no se manda nada',
        );
        return;
      }

      deps.resets.deleteExpired(at.toISOString());
      deps.resets.deleteUnusedForUser(user.id);
      const token = randomBytes(32).toString('base64url');
      deps.resets.insert({
        tokenHash: hashToken(token),
        userId: user.id,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
        ip,
      });
      const link = `${deps.publicUrl}/restablecer#token=${token}`;
      const send = deps.send;
      void send(resetMessage(user.email, user.name, link))
        .then(() => {
          deps.logger.info({ userId: user.id, ip }, 'Link de recuperación enviado por mail');
        })
        .catch((error: unknown) => {
          deps.logger.warn(
            {
              userId: user.id,
              code: error instanceof MailError ? error.code : undefined,
              err: error instanceof MailError ? error.cause : error,
            },
            'No se pudo enviar el link de recuperación',
          );
        });
    },

    /** Cambia la contraseña con el token del link. Lanza PasswordResetError si no sirve. */
    async resetPassword(token: string, password: string, ip: string): Promise<void> {
      const tokenHash = hashToken(token);
      const reset = deps.resets.get(tokenHash);
      const at = now();
      const user = reset ? deps.users.get(reset.userId) : null;
      if (
        !reset ||
        reset.usedAt !== null ||
        Date.parse(reset.expiresAt) < at.getTime() ||
        !user ||
        !user.active
      ) {
        throw new PasswordResetError('INVALID_RESET_LINK', INVALID_MESSAGE, 400);
      }
      const passwordHash = await hash(password);
      // Se marca recién ahora y con condición: si dos pedidos llegan juntos, gana uno.
      if (!deps.resets.markUsed(tokenHash, at.toISOString())) {
        throw new PasswordResetError('INVALID_RESET_LINK', INVALID_MESSAGE, 400);
      }
      deps.users.setPassword(user.id, passwordHash, false, at.toISOString());
      deps.resets.deleteUnusedForUser(user.id);
      deps.sessions.deleteForUser(user.id);
      deps.limiter?.recordSuccess(user.email);
      deps.logger.info({ userId: user.id, ip }, 'Contraseña cambiada con el link de recuperación');
    },
  };
}

export type PasswordReset = ReturnType<typeof createPasswordReset>;
