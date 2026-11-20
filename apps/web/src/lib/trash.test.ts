import type { TrashItem } from '@sti-catcher/shared';
import { describe, expect, it } from 'vitest';
import { trashSummary } from './trash.ts';

const base: TrashItem = {
  id: '00000000-0000-4000-8000-0000000000a1',
  type: 'download',
  status: 'expired',
  title: 'Video',
  sourceUrl: null,
  createdAt: '2026-11-19T12:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  error: null,
  sizeBytes: 1000,
  durationSeconds: null,
  format: 'mp4',
  resolution: null,
  videoCodec: null,
  audioCodec: null,
  parentJobId: null,
  followUpJobId: null,
  progress: null,
  inTrash: true,
  isMine: true,
  parentTitle: null,
  requester: null,
  trashKind: 'job',
  trashedAt: '2026-11-20T12:00:00.000Z',
  purgeAt: '2026-11-27T12:00:00.000Z',
  trashBytes: 1000,
};

describe('trashSummary', () => {
  it('cuenta solo lo elegido que sigue en la papelera; sin archivo no suma', () => {
    const noFile = { ...base, id: '00000000-0000-4000-8000-0000000000a2', trashBytes: null };
    const other = { ...base, id: '00000000-0000-4000-8000-0000000000a3', trashBytes: 500 };
    const selected = new Set([base.id, noFile.id, 'ya-no-esta']);
    expect(trashSummary([base, noFile, other], selected)).toEqual({
      ids: [base.id, noFile.id],
      bytes: 1000,
    });
  });
});
