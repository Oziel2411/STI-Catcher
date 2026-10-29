import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { JobRecord } from '../../jobs/types.ts';
import { buildDownloadFileName } from './file-names.ts';

export type JobFileResult =
  | { kind: 'ok'; fileName: string; downloadName: string; sizeBytes: number }
  | { kind: 'not_found' }
  | { kind: 'not_ready' }
  | { kind: 'gone' };

export type JobFilesDeps = {
  getJob: (id: string) => JobRecord | null;
  storageDir: string;
  filesDir: string;
};

/**
 * Resuelve el archivo de un job para servirlo (SPEC §8).
 *
 * El cliente solo manda un jobId (validado como UUID); la ruta sale de la
 * base, armada por el server. Igual se verifica que quede dentro de
 * `filesDir`: si la base tuviera un valor raro, no se sirve nada de afuera.
 */
export function createJobFiles(deps: JobFilesDeps) {
  const filesRoot = path.resolve(deps.filesDir) + path.sep;

  return async (jobId: string): Promise<JobFileResult> => {
    const job = deps.getJob(jobId);
    if (!job) return { kind: 'not_found' };
    if (job.status === 'expired') return { kind: 'gone' };
    if (job.status !== 'done' || job.filePath === null) return { kind: 'not_ready' };

    const absolute = path.resolve(deps.storageDir, job.filePath);
    if (!absolute.startsWith(filesRoot)) return { kind: 'not_found' };

    try {
      const info = await stat(absolute);
      if (!info.isFile()) return { kind: 'gone' };
      const extension = path.extname(absolute);
      return {
        kind: 'ok',
        fileName: path.basename(absolute),
        downloadName: buildDownloadFileName(job.title, extension),
        sizeBytes: info.size,
      };
    } catch {
      // Lo borró la retención o alguien a mano. La Fase 4 lo marca como expired.
      return { kind: 'gone' };
    }
  };
}

export type JobFiles = ReturnType<typeof createJobFiles>;
