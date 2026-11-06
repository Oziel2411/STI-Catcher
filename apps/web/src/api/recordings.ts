import {
  createRecordingResponseSchema,
  finishRecordingResponseSchema,
  apiErrorSchema,
} from '@sti-catcher/shared';
import type { CreateRecordingRequest } from '@sti-catcher/shared';
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
