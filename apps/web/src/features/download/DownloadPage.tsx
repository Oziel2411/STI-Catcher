import {
  createJobResponseSchema,
  isActiveStatus,
  jobResponseSchema,
  probeResponseSchema,
} from '@sti-catcher/shared';
import type { DownloadFormat, Job, ProbeResponse, VideoMode } from '@sti-catcher/shared';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { apiPost } from '../../api/client.ts';
import { JobProgress } from '../../components/JobProgress.tsx';
import { useTrackedJob } from '../../hooks/useTrackedJob.ts';
import {
  codecNotices,
  codecsLabel,
  defaultHeight,
  defaultMode,
  resolutionLabel,
} from '../../lib/download.ts';
import type { CodecNotice } from '../../lib/download.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

const FORMAT_OPTIONS: { value: DownloadFormat; label: string; hint: string }[] = [
  { value: 'mp4', label: 'Video (MP4)', hint: 'Video con audio.' },
  { value: 'mp3', label: 'Solo audio (MP3)', hint: 'Abre en cualquier lado.' },
  { value: 'm4a', label: 'Solo audio (M4A)', hint: 'Mejor calidad al mismo tamaño.' },
];

const MODE_OPTIONS: { value: VideoMode; label: string; hint: string }[] = [
  {
    value: 'compat',
    label: 'Compatibilidad máxima',
    hint: 'H.264 + AAC: abre en cualquier reproductor y editor. Si la resolución elegida no está en H.264, baja la mayor que sí esté.',
  },
  {
    value: 'quality',
    label: 'Máxima calidad',
    hint: 'Codec original (VP9/AV1) dentro de MP4. Rápido, pero puede no abrir en editores o reproductores viejos.',
  },
  {
    value: 'recode',
    label: 'Recodificar a H.264',
    hint: 'La resolución elegida, convertida a H.264. Lento: usa mucha CPU del servidor.',
  },
];

export function DownloadPage() {
  const [url, setUrl] = useState('');
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [format, setFormat] = useState<DownloadFormat>('mp4');
  const [height, setHeight] = useState<number | null>(null);
  const [mode, setMode] = useState<VideoMode>('compat');

  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { job, connected } = useTrackedJob(trackedId);

  const isActive = job !== null && isActiveStatus(job.status);

  const analyze = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProbing(true);
    setError(null);
    setProbe(null);
    setTrackedId(null);
    apiPost('/api/media/probe', probeResponseSchema, { url })
      .then((result) => {
        setProbe(result);
        setFormat(result.hasVideo ? 'mp4' : 'mp3');
        setHeight(defaultHeight(result));
        setMode(defaultMode(result));
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      })
      .finally(() => {
        setProbing(false);
      });
  };

  const download = () => {
    if (!probe) return;
    setSubmitting(true);
    setError(null);
    apiPost('/api/jobs/download', createJobResponseSchema, {
      url: probe.url,
      format,
      maxHeight: height,
      videoMode: mode,
      title: probe.title,
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

  const reset = () => {
    setUrl('');
    setProbe(null);
    setTrackedId(null);
    setError(null);
  };

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Descargar video</h1>
          <p className="muted">YouTube, Instagram, X y otros sitios. Pegá el link del video.</p>
        </div>
      </header>

      <form className="card url-form" onSubmit={analyze}>
        <label className="field grow">
          <span>Link del video</span>
          <input
            type="url"
            required
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
            disabled={probing || isActive}
          />
        </label>
        <button
          type="submit"
          className="button"
          disabled={probing || isActive || url.trim() === ''}
        >
          {probing ? 'Analizando…' : 'Analizar'}
        </button>
      </form>

      {probing && <p className="muted small">Consultando el sitio. Puede tardar unos segundos.</p>}
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {probe && (
        <div className="card">
          <MediaSummary probe={probe} />

          {probe.isLive ? (
            <div className="alert alert-warn" role="status">
              Es una transmisión en vivo: no se puede descargar mientras está en curso.
            </div>
          ) : (
            <>
              <fieldset className="options" disabled={isActive || submitting}>
                <legend>Formato</legend>
                {FORMAT_OPTIONS.map((option) => (
                  <label key={option.value} className="choice">
                    <input
                      type="radio"
                      name="format"
                      value={option.value}
                      checked={format === option.value}
                      disabled={option.value === 'mp4' ? !probe.hasVideo : !probe.hasAudio}
                      onChange={() => {
                        setFormat(option.value);
                      }}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <span className="muted small"> — {option.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {format === 'mp4' && (
                <>
                  <fieldset className="options" disabled={isActive || submitting}>
                    <legend>Resolución</legend>
                    <select
                      aria-label="Resolución"
                      value={height ?? ''}
                      onChange={(e) => {
                        setHeight(e.target.value === '' ? null : Number(e.target.value));
                      }}
                    >
                      {probe.resolutions.length === 0 && <option value="">Mejor disponible</option>}
                      {probe.resolutions.map((option) => (
                        <option key={option.height} value={option.height}>
                          {resolutionLabel(option)}
                        </option>
                      ))}
                    </select>
                  </fieldset>

                  <fieldset className="options" disabled={isActive || submitting}>
                    <legend>Codec</legend>
                    {MODE_OPTIONS.map((option) => {
                      const unavailable = option.value === 'compat' && probe.maxH264Height === null;
                      return (
                        <label key={option.value} className="choice">
                          <input
                            type="radio"
                            name="mode"
                            value={option.value}
                            checked={mode === option.value}
                            disabled={unavailable}
                            onChange={() => {
                              setMode(option.value);
                            }}
                          />
                          <span>
                            <strong>{option.label}</strong>
                            {option.value === 'compat' && ' (recomendado)'}
                            <span className="muted small"> — {option.hint}</span>
                            {unavailable && (
                              <span className="small text-warn">
                                {' '}
                                No disponible: este video no está en H.264.
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>

                  {codecNotices(probe, height, mode).map((notice) => (
                    <NoticeView key={notice.kind} notice={notice} />
                  ))}
                </>
              )}

              <div className="row">
                {isActive ? (
                  <button type="button" className="button button-danger" onClick={cancel}>
                    Cancelar
                  </button>
                ) : (
                  <button type="button" className="button" onClick={download} disabled={submitting}>
                    {submitting ? 'Creando…' : 'Descargar'}
                  </button>
                )}
                {job && !isActive && (
                  <button type="button" className="button button-secondary" onClick={reset}>
                    Descargar otro
                  </button>
                )}
              </div>
            </>
          )}

          {trackedId !== null && job === null && <p className="muted small">Conectando…</p>}
          {job && (
            <JobProgress job={job} connected={connected} doneContent={<DoneDetails job={job} />} />
          )}
        </div>
      )}
    </section>
  );
}

function MediaSummary({ probe }: { probe: ProbeResponse }) {
  return (
    <div className="media-summary">
      {probe.thumbnailUrl && (
        // referrerPolicy: no se le avisa al sitio desde qué página interna se mira.
        <img
          className="thumbnail"
          src={probe.thumbnailUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )}
      <div>
        <h2 className="media-title">{probe.title}</h2>
        <p className="muted small">
          {[probe.site, probe.uploader, formatDuration(probe.durationSeconds)]
            .filter((part) => part !== null && part !== '—')
            .join(' · ')}
        </p>
      </div>
    </div>
  );
}

function NoticeView({ notice }: { notice: CodecNotice }) {
  switch (notice.kind) {
    case 'compat-downgrade':
      return (
        <div className="alert alert-warn" role="status">
          En {notice.requested}p este video solo está en {codecsLabel(notice.codecs)}. Con
          «Compatibilidad máxima» vas a obtener <strong>{notice.h264Height}p en H.264</strong>. Para
          tener {notice.requested}p elegí «Máxima calidad» (rápido, menos compatible) o «Recodificar
          a H.264» (lento).
        </div>
      );
    case 'compat-impossible':
      return (
        <div className="alert alert-warn" role="status">
          No hay versión en H.264 en esta resolución ni en una menor. Elegí otra resolución, «Máxima
          calidad» o «Recodificar a H.264».
        </div>
      );
    case 'quality-codec':
      return (
        <div className="alert alert-warn" role="status">
          El MP4 va a quedar en {codecsLabel(notice.codecs)}, no en H.264: puede no abrir en
          reproductores o editores viejos.
        </div>
      );
    case 'recode-slow':
      return (
        <div className="alert alert-warn" role="status">
          Recodificar es lento: puede tardar varias veces la duración del video y usa mucha CPU del
          servidor, lo que demora los trabajos de los demás.
        </div>
      );
  }
}

function DoneDetails({ job }: { job: Job }) {
  const details = [
    job.resolution,
    [job.videoCodec, job.audioCodec].filter(Boolean).join(' + ') || null,
    job.sizeBytes !== null ? formatBytes(job.sizeBytes) : null,
  ].filter((part): part is string => part !== null && part !== '');
  return (
    <div className="row">
      <a className="button" href={`/api/jobs/${job.id}/file`} download>
        Descargar archivo
      </a>
      {details.length > 0 && <span className="muted small">{details.join(' · ')}</span>}
    </div>
  );
}
