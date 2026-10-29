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
  /** Se llama si un job terminado ya no tiene su archivo (lo marca como expirado). */
  onMissing?: (jobId: string) => void;
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

    const isFile = await stat(absolute).then(
      (info) => (info.isFile() ? info : null),
      () => null,
    );
    if (isFile === null) {
      // Lo borró la retención o alguien a mano: pasa a expired (SPEC §8).
      deps.onMissing?.(jobId);
      return { kind: 'gone' };
    }
    return {
      kind: 'ok',
      fileName: path.basename(absolute),
      downloadName: buildDownloadFileName(job.title, path.extname(absolute)),
      sizeBytes: isFile.size,
    };
  };
}

export type JobFiles = ReturnType<typeof createJobFiles>;
