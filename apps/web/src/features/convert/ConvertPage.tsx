import {
  CONVERSION_PRESETS,
  conversionOptionsResponseSchema,
  conversionSourceResponseSchema,
  createJobResponseSchema,
  isActiveStatus,
  jobResponseSchema,
} from '@sti-catcher/shared';
import type {
  ConversionOptionsResponse,
  ConversionPresetId,
  ConversionSourceResponse,
  GifOptions,
  Job,
} from '@sti-catcher/shared';
import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiGet, apiPost } from '../../api/client.ts';
import { uploadFile } from '../../api/upload.ts';
import type { UploadHandle, UploadProgress } from '../../api/upload.ts';
import { JobProgress } from '../../components/JobProgress.tsx';
import { useTrackedJob } from '../../hooks/useTrackedJob.ts';
import {
  defaultGif,
  defaultPreset,
  gifFpsOptions,
  gifProblems,
  gifWidthOptions,
  isScalable,
  PRESET_GROUPS,
  scaleOptions,
} from '../../lib/convert.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { TYPE_LABELS } from '../../lib/jobs.ts';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

/**
 * Conversión (SPEC §7). El origen es un archivo subido o uno del historial
 * (?origen=<jobId>, el link "Convertir" del historial). El server analiza el
 * archivo y dice qué formatos tienen sentido: solo esos se muestran.
 */
export function ConvertPage() {
  const [params, setParams] = useSearchParams();
  const sourceId = params.get('origen');
  const [options, setOptions] = useState<ConversionOptionsResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet('/api/conversion/options', conversionOptionsResponseSchema, controller.signal)
      .then(setOptions)
      .catch(() => {
        // Sin opciones se usa el límite que informe el server al subir.
      });
    return () => {
      controller.abort();
    };
  }, []);

  const chooseSource = (jobId: string | null) => {
    setParams(jobId === null ? {} : { origen: jobId });
  };

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Convertir archivos</h1>
          <p className="muted">
            Video y audio entre MP4, WebM, MKV, MOV, AVI, GIF, MP3, M4A y WAV.
          </p>
        </div>
      </header>

      {sourceId === null ? (
        <UploadCard
          maxUploadBytes={options?.maxUploadBytes ?? null}
          onUploaded={(jobId) => {
            chooseSource(jobId);
          }}
        />
      ) : (
        options && (
          <ConvertSource
            key={sourceId}
            sourceId={sourceId}
            options={options}
            onChangeSource={() => {
              chooseSource(null);
            }}
          />
        )
      )}
    </section>
  );
}

function UploadCard({
  maxUploadBytes,
  onUploaded,
}: {
  maxUploadBytes: number | null;
  onUploaded: (jobId: string) => void;
}) {
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const handleRef = useRef<UploadHandle | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      handleRef.current?.abort();
    },
    [],
  );

  const start = (file: File) => {
    setError(null);
    if (maxUploadBytes !== null && file.size > maxUploadBytes) {
      setError(
        `El archivo pesa ${formatBytes(file.size)} y el máximo es ${formatBytes(maxUploadBytes)}.`,
      );
      return;
    }
    setFileName(file.name);
    setProgress({ loadedBytes: 0, totalBytes: file.size });
    const handle = uploadFile(file, setProgress);
    handleRef.current = handle;
    handle.promise
      .then(({ jobId }) => {
        onUploaded(jobId);
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
        setProgress(null);
      })
      .finally(() => {
        handleRef.current = null;
      });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file && progress === null) start(file);
  };

  const uploading = progress !== null;
  const percent =
    progress && progress.totalBytes > 0 ? (progress.loadedBytes / progress.totalBytes) * 100 : 0;

  return (
    <div className="card">
      <h2>Archivo de origen</h2>
      <p className="muted small">
        Subí un archivo de video o audio, o elegí uno del <Link to="/historial">historial</Link> con
        el botón «Convertir».
      </p>
      <div
        className={`dropzone ${dragging ? 'dropzone-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={onDrop}
      >
        {uploading ? (
          <>
            <p className="small">
              Subiendo <strong>{fileName}</strong>: {formatBytes(progress.loadedBytes)} de{' '}
              {formatBytes(progress.totalBytes)}
            </p>
            <div
              className="meter"
              role="progressbar"
              aria-label="Subida"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
            >
              <div className="meter-fill" style={{ width: `${String(percent)}%` }} />
            </div>
            {percent >= 100 && <p className="small muted">Analizando el archivo…</p>}
            <button
              type="button"
              className="button button-secondary"
              onClick={() => handleRef.current?.abort()}
            >
              Cancelar subida
            </button>
          </>
        ) : (
          <>
            <p>Arrastrá un archivo acá o</p>
            <button type="button" className="button" onClick={() => inputRef.current?.click()}>
              Elegir archivo
            </button>
            {maxUploadBytes !== null && (
              <p className="small muted">Máximo {formatBytes(maxUploadBytes)}.</p>
            )}
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="video/*,audio/*,.mkv,.avi,.mov"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) start(file);
          }}
        />
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

type SourceState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ConversionSourceResponse };

function ConvertSource({
  sourceId,
  options,
  onChangeSource,
}: {
  sourceId: string;
  options: ConversionOptionsResponse;
  onChangeSource: () => void;
}) {
  const [state, setState] = useState<SourceState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    apiGet(
      `/api/conversion/sources/${encodeURIComponent(sourceId)}`,
      conversionSourceResponseSchema,
      controller.signal,
    )
      .then((data) => {
        setState({ kind: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: 'error', message: errorMessage(error) });
      });
    return () => {
      controller.abort();
    };
  }, [sourceId]);

  if (state.kind === 'loading') return <p className="muted">Analizando el archivo…</p>;
  if (state.kind === 'error') {
    return (
      <>
        <div className="alert alert-error" role="alert">
          {state.message}
        </div>
        <button type="button" className="button button-secondary" onClick={onChangeSource}>
          Elegir otro archivo
        </button>
      </>
    );
  }
  return <ConvertForm source={state.data} options={options} onChangeSource={onChangeSource} />;
}

function ConvertForm({
  source,
  options,
  onChangeSource,
}: {
  source: ConversionSourceResponse;
  options: ConversionOptionsResponse;
  onChangeSource: () => void;
}) {
  const { job: sourceJob, media, presets } = source;
  const [preset, setPreset] = useState<ConversionPresetId | null>(defaultPreset(presets));
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [gif, setGif] = useState<GifOptions>(() => defaultGif(media, options.gif));
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job, connected } = useTrackedJob(trackedId);
  const active = job !== null && isActiveStatus(job.status);

  const problems = preset === 'gif' ? gifProblems(gif, media, options.gif) : [];
  const heights = scaleOptions(media.height);

  const convert = () => {
    if (preset === null) return;
    setSubmitting(true);
    setError(null);
    apiPost('/api/jobs/convert', createJobResponseSchema, {
      sourceJobId: sourceJob.id,
      preset,
      maxHeight: isScalable(preset) ? maxHeight : null,
      ...(preset === 'gif' ? { gif } : {}),
    })
      .then(({ jobId }) => {
        setTrackedId(jobId);
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const cancel = () => {
    if (!job) return;
    apiPost(`/api/jobs/${job.id}/cancel`, jobResponseSchema).catch((e: unknown) => {
      setError(errorMessage(e));
    });
  };

  const sourceDetails = [
    TYPE_LABELS[sourceJob.type],
    formatDuration(media.durationSeconds),
    media.width !== null && media.height !== null
      ? `${String(media.width)}x${String(media.height)}`
      : null,
    [media.videoCodec, media.audioCodec].filter(Boolean).join(' + ') || null,
    sourceJob.sizeBytes !== null ? formatBytes(sourceJob.sizeBytes) : null,
  ].filter((part): part is string => part !== null && part !== '—');

  return (
    <div className="card">
      <div className="media-summary">
        <div>
          <h2 className="media-title">{sourceJob.title ?? 'Archivo'}</h2>
          <p className="muted small">{sourceDetails.join(' · ')}</p>
        </div>
      </div>
      <button
        type="button"
        className="button button-secondary"
        onClick={onChangeSource}
        disabled={active}
      >
        Usar otro archivo
      </button>

      {!media.hasVideo && (
        <div className="alert alert-warn" role="status">
          Este archivo no tiene video: solo se puede convertir a formatos de audio.
        </div>
      )}
      {!media.hasAudio && media.hasVideo && (
        <div className="alert alert-warn" role="status">
          Este archivo no tiene audio: no se ofrecen formatos de solo audio.
        </div>
      )}

      <fieldset className="options" disabled={active || submitting}>
        <legend>Formato de salida</legend>
        {PRESET_GROUPS.map((group) => {
          const ids = group.ids.filter((id) => presets.includes(id));
          if (ids.length === 0) return null;
          return (
            <div key={group.title} className="preset-group">
              <p className="small muted preset-group-title">{group.title}</p>
              {ids.map((id) => (
                <label key={id} className="choice">
                  <input
                    type="radio"
                    name="preset"
                    value={id}
                    checked={preset === id}
                    onChange={() => {
                      setPreset(id);
                    }}
                  />
                  <span>
                    <strong>{CONVERSION_PRESETS[id].label}</strong>
                    <span className="muted small"> — {CONVERSION_PRESETS[id].description}</span>
                  </span>
                </label>
              ))}
            </div>
          );
        })}
      </fieldset>

      {preset !== null && isScalable(preset) && heights.length > 0 && (
        <fieldset className="options" disabled={active || submitting}>
          <legend>Resolución</legend>
          <select
            aria-label="Resolución"
            value={maxHeight ?? ''}
            onChange={(e) => {
              setMaxHeight(e.target.value === '' ? null : Number(e.target.value));
            }}
          >
            <option value="">Mantener ({String(media.height)}p)</option>
            {heights.map((height) => (
              <option key={height} value={height}>
                Reducir a {height}p
              </option>
            ))}
          </select>
        </fieldset>
      )}

      {preset === 'gif' && (
        <fieldset className="options gif-options" disabled={active || submitting}>
          <legend>GIF</legend>
          <div className="row">
            <label className="field">
              <span>Inicio (s)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={gif.startSeconds}
                onChange={(e) => {
                  setGif({ ...gif, startSeconds: Number(e.target.value) });
                }}
              />
            </label>
            <label className="field">
              <span>Fin (s)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={gif.endSeconds}
                onChange={(e) => {
                  setGif({ ...gif, endSeconds: Number(e.target.value) });
                }}
              />
            </label>
            <label className="field">
              <span>Cuadros por segundo</span>
              <select
                value={gif.fps}
                onChange={(e) => {
                  setGif({ ...gif, fps: Number(e.target.value) });
                }}
              >
                {gifFpsOptions(options.gif).map((fps) => (
                  <option key={fps} value={fps}>
                    {fps}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Ancho</span>
              <select
                value={gif.width}
                onChange={(e) => {
                  setGif({ ...gif, width: Number(e.target.value) });
                }}
              >
                {gifWidthOptions(options.gif, media.width).map((width) => (
                  <option key={width} value={width}>
                    {width} px
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="small muted">
            Duración del GIF:{' '}
            {Math.max(0, gif.endSeconds - gif.startSeconds)
              .toFixed(1)
              .replace('.', ',')}{' '}
            s (máximo {options.gif.maxSeconds} s). Sin sonido.
          </p>
          {problems.map((problem) => (
            <p key={problem} className="small text-error">
              {problem}
            </p>
          ))}
        </fieldset>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <div className="row">
        {active ? (
          <button type="button" className="button button-danger" onClick={cancel}>
            Cancelar
          </button>
        ) : (
          <button
            type="button"
            className="button"
            onClick={convert}
            disabled={preset === null || submitting || problems.length > 0}
          >
            {submitting ? 'Creando…' : 'Convertir'}
          </button>
        )}
      </div>

      {trackedId !== null && job === null && <p className="muted small">Conectando…</p>}
      {job && (
        <JobProgress job={job} connected={connected} doneContent={<ConvertDone job={job} />} />
      )}
    </div>
  );
}

function ConvertDone({ job }: { job: Job }) {
  const details = [
    job.resolution,
    [job.videoCodec, job.audioCodec].filter(Boolean).join(' + ') || null,
    job.sizeBytes !== null ? formatBytes(job.sizeBytes) : null,
  ].filter((part): part is string => part !== null && part !== '');
  return (
    <div className="row">
      <a className="button" href={`/api/jobs/${job.id}/file`} download>
        Descargar
      </a>
      <Link className="button button-secondary" to="/historial">
        Ver en el historial
      </Link>
      {details.length > 0 && <span className="muted small">{details.join(' · ')}</span>}
    </div>
  );
}
