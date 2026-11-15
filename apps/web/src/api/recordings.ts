import {
  createRecordingResponseSchema,
  createRecordingScheduleResponseSchema,
  finishRecordingResponseSchema,
  apiErrorSchema,
} from '@sti-catcher/shared';
import type { CreateRecordingRequest, CreateRecordingScheduleRequest } from '@sti-catcher/shared';
import { z } from 'zod';
import { ApiClientError, apiPost, httpErrorMessage, NETWORK_ERROR_MESSAGE } from './client.ts';
import type { SendChunk } from './chunk-uploader.ts';

export const createRecording = (request: CreateRecordingRequest) =>
  apiPost('/api/recordings', createRecordingResponseSchema, request);

export const finishRecording = (recordingId: string) =>
  apiPost(
    `/api/recordings/${encodeURIComponent(recordingId)}/finish`,
    finishRecordingResponseSchema,
  );

/** Envía un fragmento como application/octet-stream (el server lo agrega al archivo). */
export const chunkSender =
  (recordingId: string): SendChunk =>
  async (seq, blob) => {
    let response: Response;
    try {
      response = await fetch(
        `/api/recordings/${encodeURIComponent(recordingId)}/chunks?seq=${String(seq)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
          body: blob,
        },
      );
    } catch {
      throw new ApiClientError(NETWORK_ERROR_MESSAGE, 'NETWORK_ERROR', null);
    }
    if (response.ok) return;
    const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
    throw parsed.success
      ? new ApiClientError(parsed.data.error.message, parsed.data.error.code, response.status)
      : new ApiClientError(httpErrorMessage(response.status), 'HTTP_ERROR', response.status);
  };

/** Grabación programada (D-109): el server avisa si a la hora no empezó. */
export const createRecordingSchedule = (request: CreateRecordingScheduleRequest) =>
  apiPost('/api/recording-schedules', createRecordingScheduleResponseSchema, request);

export const cancelRecordingSchedule = (scheduleId: string) =>
  apiPost(`/api/recording-schedules/${encodeURIComponent(scheduleId)}/cancel`, z.null());

/** La pestaña no pudo empezar: el server avisa en el momento. */
export const failRecordingSchedule = (scheduleId: string, reason: string) =>
  apiPost(`/api/recording-schedules/${encodeURIComponent(scheduleId)}/fail`, z.null(), {
    reason: reason.slice(0, 300),
  });
