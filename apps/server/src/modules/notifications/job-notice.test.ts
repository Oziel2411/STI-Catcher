import { describe, expect, it } from 'vitest';
import { describeMailError, MailError } from '../../adapters/mailer.ts';
import type { JobRecord } from '../../jobs/types.ts';
import { jobNoticeMessage, shouldNotify } from './job-notice.ts';

const ANA = '11111111-1111-4111-8111-111111111111';

const record = (patch: Partial<JobRecord> = {}): JobRecord => ({
  id: '22222222-2222-4222-8222-222222222222',
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
  userId: ANA,
  notifyUserIds: [ANA],
  clientHost: 'PC-SALA',
  parentJobId: null,
  followUpJobId: null,
  ...patch,
});

describe('jobNoticeMessage', () => {
  it('grabación terminada: datos, quién la pidió y link al Historial', () => {
    const message = jobNoticeMessage(record(), ['a@capitanes.ar'], 'Ana', 'https://sti.local');
    expect(message.to).toEqual(['a@capitanes.ar']);
    expect(message.subject).toBe('Grabación terminada: Reunión de armadores');
    expect(message.text).toBe(
      [
        'La grabación «Reunión de armadores» terminó y ya está en el Historial de STI-Catcher.',
        '',
        'Duración: 1:02:05',
        'Resolución: 1920x1080',
        'Tamaño: 5,7 MB',
        'Pedida por: Ana (desde PC-SALA)',
        'Empezó: 04/11/2026 14:00',
        'Terminó: 04/11/2026 15:02',
        '',
        'Historial: https://sti.local/historial',
        '',
        'Te llega porque te eligieron para avisarte al pedir este trabajo.',
        'Mensaje automático de STI-Catcher. No hace falta responder.',
      ].join('\n'),
    );
  });

  it('falla: el motivo en vez de los datos; sin PUBLIC_URL, sin link', () => {
    const text = jobNoticeMessage(
      record({ type: 'conversion', status: 'failed', error: 'El archivo está dañado.' }),
      ['a@capitanes.ar'],
      'Ana',
      null,
    );
    expect(text.subject).toBe('Falló la conversión: Reunión de armadores');
    expect(text.text).toContain('La conversión «Reunión de armadores» no se pudo completar.');
    expect(text.text).toContain('Motivo: El archivo está dañado.');
    expect(text.text).toContain('Falló: 04/11/2026 15:02');
    expect(text.text).not.toContain('Duración');
    expect(text.text).not.toContain('Historial:');
  });

  it('sin nombre de cuenta ni PC: la IP', () => {
    const text = jobNoticeMessage(record({ clientHost: null }), ['a@x.ar'], null, null).text;
    expect(text).toContain('Pedida por: 192.168.3.40');
  });
});

describe('shouldNotify', () => {
  it('solo terminados o fallidos de grabación, descarga y conversión, con alguien elegido', () => {
    expect(shouldNotify(record())).toBe(true);
    expect(shouldNotify(record({ status: 'failed' }))).toBe(true);
    expect(shouldNotify(record({ status: 'cancelled' }))).toBe(false);
    expect(shouldNotify(record({ notifyUserIds: [] }))).toBe(false);
    expect(shouldNotify(record({ type: 'upload' }))).toBe(false);
    expect(shouldNotify(record({ type: 'selftest' }))).toBe(false);
  });

  it('una descarga que se convierte no avisa al bajar (avisa la conversión), pero sí si falla', () => {
    const params = {
      url: 'https://youtu.be/x',
      format: 'm4a',
      maxHeight: null,
      videoMode: 'compat',
      then: { preset: 'mp3' },
    };
    expect(shouldNotify(record({ type: 'download', params }))).toBe(false);
    expect(shouldNotify(record({ type: 'download', params, status: 'failed' }))).toBe(true);
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
