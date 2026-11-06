import { describe, expect, it, vi } from 'vitest';
import { describeMailError, MailError } from '../../adapters/mailer.ts';
import type { JobRecord } from '../../jobs/types.ts';
import { createRecordingNotice, recordingDoneMessage } from './recording-notice.ts';

const record = (patch: Partial<JobRecord> = {}): JobRecord => ({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'recording',
  status: 'done',
  params: {},
  sourceUrl: null,
  title: 'Reunión de armadores',
  format: 'mp4',
  resolution: '1920x1080',
  videoCodec: 'h264',
  audioCodec: 'aac',
  sizeBytes: 5_983_232,
  durationSeconds: 3725.4,
  filePath: 'files/x.mp4',
  createdAt: new Date(2026, 10, 4, 14, 0).toISOString(),
  startedAt: null,
  finishedAt: new Date(2026, 10, 4, 15, 2).toISOString(),
  error: null,
  clientIp: '192.168.3.40',
  clientId: null,
  userId: null,
  clientHost: 'PC-SALA',
  parentJobId: null,
  followUpJobId: null,
  ...patch,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('recordingDoneMessage', () => {
  it('asunto con el título y los datos de la grabación', () => {
    const message = recordingDoneMessage(record(), ['a@capitanes.ar']);
    expect(message.to).toEqual(['a@capitanes.ar']);
    expect(message.subject).toBe('Grabación terminada: Reunión de armadores');
    expect(message.text).toBe(
      [
        'La grabación «Reunión de armadores» terminó y ya está en el Historial de STI-Catcher.',
        '',
        'Duración: 1:02:05',
        'Resolución: 1920x1080',
        'Tamaño: 5,7 MB',
        'Pedida desde: PC-SALA',
        'Empezó: 04/11/2026 14:00',
        'Terminó: 04/11/2026 15:02',
        '',
        'Mensaje automático de STI-Catcher. No hace falta responder.',
      ].join('\n'),
    );
  });

  it('omite lo que no se sabe; sin nombre de PC, la IP', () => {
    const text = recordingDoneMessage(
      record({ resolution: null, sizeBytes: null, clientHost: null }),
      ['a@capitanes.ar'],
    ).text;
    expect(text).not.toContain('Resolución');
    expect(text).not.toContain('Tamaño');
    expect(text).toContain('Pedida desde: 192.168.3.40');
  });
});

describe('createRecordingNotice', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn() });

  it('manda solo por grabaciones terminadas y si hay destinatarios', async () => {
    const send = vi.fn(() => Promise.resolve());
    const notice = createRecordingNotice({ send, to: ['a@capitanes.ar'], logger: logger() });
    notice(record({ type: 'download' }));
    notice(record({ type: 'conversion' }));
    notice(record());
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    const nobody = vi.fn(() => Promise.resolve());
    createRecordingNotice({ send: nobody, to: [], logger: logger() })(record());
    await flush();
    expect(nobody).not.toHaveBeenCalled();
  });

  it('un envío fallido queda en el log y no rompe nada', async () => {
    const log = logger();
    const notice = createRecordingNotice({
      send: () => Promise.reject(describeMailError({ code: 'EAUTH' })),
      to: ['a@capitanes.ar'],
      logger: log,
    });
    expect(() => {
      notice(record());
    }).not.toThrow();
    await flush();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EAUTH' }),
      'No se pudo enviar el aviso de grabación por mail',
    );
  });
});

describe('describeMailError', () => {
  it('traduce los códigos de nodemailer, sin datos de la cuenta', () => {
    const auth = describeMailError({ code: 'EAUTH', response: '535 auth failed user@x pass' });
    expect(auth).toBeInstanceOf(MailError);
    expect(auth.message).toContain('usuario o la contraseña');
    expect(auth.message).not.toContain('pass');
    expect(describeMailError(new Error('raro')).message).toContain('log del servidor');
  });
});
