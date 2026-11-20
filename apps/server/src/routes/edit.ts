import { editRequestSchema, jobIdParamsSchema } from '@sti-catcher/shared';
import type { EditResponse } from '@sti-catcher/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError, parseInput } from '../http/validation.ts';
import { EditError } from '../modules/edit/edit-service.ts';
import type { EditService } from '../modules/edit/edit-service.ts';
import type { NoticeBatchService } from '../modules/notifications/notice-batches.ts';
import { requesterOf } from './history.ts';
import { rethrowJobRejection } from './jobs.ts';
import { assertNoticeBatch } from './mail.ts';

export type EditRoutesOptions = {
  edit: EditService;
  noticeBatches: NoticeBatchService;
};

const toHttpError = (error: unknown): unknown =>
  error instanceof EditError ? new HttpError(error.status, error.code, error.message) : error;

/** Recortar y dividir (D-112). */
export function registerEditRoutes(app: FastifyInstance, options: EditRoutesOptions): void {
  app.get('/api/edit/sources/:id', async (request) => {
    const { id } = parseInput(jobIdParamsSchema, request.params);
    try {
      return await options.edit.getSource(id);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post('/api/jobs/edit', async (request, reply) => {
    const body = parseInput(editRequestSchema, request.body ?? {});
    const requester = requesterOf(request);
    if (requester.userId !== null) {
      assertNoticeBatch(options.noticeBatches, body.batchId, requester.userId);
    }
    try {
      const jobs = await options.edit.enqueue(body, requester);
      const response: EditResponse = { jobIds: jobs.map((job) => job.id) };
      return await reply.status(202).send(response);
    } catch (error) {
      rethrowJobRejection(error);
      throw toHttpError(error);
    }
  });
}
