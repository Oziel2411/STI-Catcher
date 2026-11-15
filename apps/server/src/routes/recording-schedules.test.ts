import { rmSync } from 'node:fs';
import {
  createRecordingResponseSchema,
  createRecordingScheduleResponseSchema,
} from '@sti-catcher/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { flush, makeTestApp } from '../../test/test-app.ts';
import { NOT_STARTED_REASON, SCHEDULE_GRACE_MS } from '../modules/recording/schedule-service.ts';

const storageDirs: string[] = [];
afterEach(() => {
  for (const dir of storageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function app() {
  const testApp = await makeTestApp();
  storageDirs.push(testApp.storageDir);
  const beto = await testApp.loginAs('beto@capitanes.ar');
  return { ...testApp, beto };
}
type TestApp = Awaited<ReturnType<typeof app>>;

const MIME = 'video/webm;codecs=vp9,opus';
const minutes = (t: TestApp, n: number) => new Date(t.clock.now.getTime() + n * 60_000);

async function schedule(t: TestApp, startInMinutes: number, notify: string[]) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/recording-schedules',
    payload: {
      startAt: minutes(t, startInMinutes).toISOString(),
      stopAt: minutes(t, startInMinutes + 30).toISOString(),
      title: 'Reunión de armadores',
      notify,
    },
  });
  expect(response.statusCode).toBe(201);
  return createRecordingScheduleResponseSchema.parse(response.json()).scheduleId;
}

const startRecording = (t: TestApp, payload: Record<string, unknown>) =>
  t.app.inject({
    method: 'POST',
    url: '/api/recordings',
    payload: { mimeType: MIME, fps: 30, title: 'Reunión de armadores', ...payload },
  });

describe('grabación programada (D-109)', () => {
  it('al empezar una programada avisa el inicio y la hora de corte', async () => {
    const t = await app();
    const response = await startRecording(t, {
      notify: [t.ana.user.id, t.beto.user.id],
      programmed: true,
      stopAt: minutes(t, 45).toISOString(),
    });
    expect(response.statusCode).toBe(201);
    createRecordingResponseSchema.parse(response.json());
    await flush();
    expect(t.sentMails).toHaveLength(1);
    const mail = t.sentMails[0];
    expect(mail?.to).toEqual(['ana@capitanes.ar', 'beto@capitanes.ar']);
    expect(mail?.subject).toBe('Empezó la grabación: Reunión de armadores');
    expect(mail?.text).toMatch(/empezó a las \d\d:\d\d\./);
    expect(mail?.text).toMatch(/Está programada para terminar el \d\d\/\d\d\/\d{4} \d\d:\d\d\./);
    expect(mail?.text).toContain('Programada por: ana (desde 127.0.0.1)');
  });

  it('una grabación a mano no avisa al empezar; sin nadie elegido, tampoco', async () => {
    const t = await app();
    await startRecording(t, { notify: [t.ana.user.id] });
    await startRecording(t, { notify: [], programmed: true });
    await flush();
    expect(t.sentMails).toHaveLength(0);
  });

  it('si a la hora (más 2 minutos) no empezó, avisa una sola vez', async () => {
    const t = await app();
    await schedule(t, 10, [t.ana.user.id]);
    t.clock.now = minutes(t, 11);
    t.recordingSchedules.sweep();
    await flush();
    expect(t.sentMails).toHaveLength(0);

    t.clock.now = new Date(t.clock.now.getTime() + SCHEDULE_GRACE_MS);
    t.recordingSchedules.sweep();
    await flush();
    expect(t.sentMails).toHaveLength(1);
    expect(t.sentMails[0]?.subject).toBe('No empezó la grabación programada: Reunión de armadores');
    expect(t.sentMails[0]?.text).toContain(`Motivo: ${NOT_STARTED_REASON}`);

    t.recordingSchedules.sweep();
    await flush();
    expect(t.sentMails).toHaveLength(1);
  });

  it('si empezó, la programación se cumple: no hay aviso de que no empezó', async () => {
    const t = await app();
    const scheduleId = await schedule(t, 5, [t.ana.user.id]);
    t.clock.now = minutes(t, 5);
    const started = await startRecording(t, {
      notify: [t.ana.user.id],
      programmed: true,
      scheduleId,
    });
    expect(started.statusCode).toBe(201);
    t.clock.now = minutes(t, 10);
    t.recordingSchedules.sweep();
    await flush();
    expect(t.sentMails.map((m) => m.subject)).toEqual([
      'Empezó la grabación: Reunión de armadores',
    ]);
  });

  it('la pestaña avisa que no pudo empezar: mail en el momento, con el motivo', async () => {
    const t = await app();
    const scheduleId = await schedule(t, 30, [t.ana.user.id]);
    const failed = await t.app.inject({
      method: 'POST',
      url: `/api/recording-schedules/${scheduleId}/fail`,
      payload: { reason: 'Se dejó de compartir la pantalla antes de la hora de inicio.' },
    });
    expect(failed.statusCode).toBe(204);
    await flush();
    expect(t.sentMails).toHaveLength(1);
    expect(t.sentMails[0]?.text).toContain(
      'Motivo: Se dejó de compartir la pantalla antes de la hora de inicio.',
    );
    t.clock.now = minutes(t, 60);
    t.recordingSchedules.sweep();
    await flush();
    expect(t.sentMails).toHaveLength(1);
  });

  it('cancelada no avisa; la programación es de quien la hizo', async () => {
    const t = await app();
    const scheduleId = await schedule(t, 5, [t.ana.user.id]);
    const ajena = await t.app.inject({
      method: 'POST',
      url: `/api/recording-schedules/${scheduleId}/cancel`,
      headers: t.beto.headers,
    });
    expect(ajena.statusCode).toBe(404);
    const cancelled = await t.app.inject({
      method: 'POST',
      url: `/api/recording-schedules/${scheduleId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(204);
    t.clock.now = minutes(t, 30);
    t.recordingSchedules.sweep();
    await flush();
    expect(t.sentMails).toHaveLength(0);
  });

  it('el id de una programación ajena no la cumple', async () => {
    const t = await app();
    const scheduleId = await schedule(t, 5, [t.ana.user.id]);
    await t.app.inject({
      method: 'POST',
      url: '/api/recordings',
      payload: { mimeType: MIME, fps: 30, title: 'Otra', scheduleId },
      headers: t.beto.headers,
    });
    t.clock.now = minutes(t, 10);
    t.recordingSchedules.sweep();
    await flush();
    expect(t.sentMails.map((m) => m.subject)).toEqual([
      'No empezó la grabación programada: Reunión de armadores',
    ]);
  });
});

describe('grabación que no llegó a grabar nada (D-109)', () => {
  it('al detenerla vacía avisa que falló', async () => {
    const t = await app();
    const created = createRecordingResponseSchema.parse(
      (await startRecording(t, { notify: [t.ana.user.id] })).json(),
    );
    const finished = await t.app.inject({
      method: 'POST',
      url: `/api/recordings/${created.recordingId}/finish`,
    });
    expect(finished.statusCode).toBe(409);
    await flush();
    expect(t.sentMails.map((m) => m.subject)).toEqual(['Falló la grabación: Reunión de armadores']);
    expect(t.sentMails[0]?.text).toContain('Motivo: no llegó a grabarse nada');
  });

  it('abandonada sin fragmentos (pestaña cerrada al empezar): avisa al descartarla', async () => {
    const t = await app();
    await startRecording(t, { notify: [t.ana.user.id], programmed: true });
    await flush();
    expect(t.sentMails.map((m) => m.subject)).toEqual([
      'Empezó la grabación: Reunión de armadores',
    ]);
    t.clock.now = minutes(t, 10);
    await t.recordings.sweepIdle();
    await flush();
    expect(t.sentMails.map((m) => m.subject)).toEqual([
      'Empezó la grabación: Reunión de armadores',
      'Falló la grabación: Reunión de armadores',
    ]);
  });

  it('sin nadie elegido, no avisa', async () => {
    const t = await app();
    const created = createRecordingResponseSchema.parse((await startRecording(t, {})).json());
    await t.app.inject({ method: 'POST', url: `/api/recordings/${created.recordingId}/finish` });
    await flush();
    expect(t.sentMails).toHaveLength(0);
  });
});
