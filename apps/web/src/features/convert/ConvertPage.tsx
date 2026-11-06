import { ArrowDownIcon, ArrowsLeftRightIcon, FilesIcon, PlusIcon } from '@phosphor-icons/react';
import {
  CONVERSION_PRESETS,
  conversionOptionsResponseSchema,
  isActiveStatus,
} from '@sti-catcher/shared';
import type {
  ConversionOptionsResponse,
  ConversionPresetId,
  GifLimits,
  Job,
} from '@sti-catcher/shared';
import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiGet } from '../../api/client.ts';
import { JobProgress } from '../../components/JobProgress.tsx';
import { PageTitle } from '../../components/PageTitle.tsx';
import { gifFpsOptions, isScalable, scaleOptions } from '../../lib/convert.ts';
import {
  formatTag,
  isConverting,
  itemGifWidths,
  itemMeta,
  itemProblems,
  parseOrigin,
} from '../../lib/convert-batch.ts';
import type { ConvertItem } from '../../lib/convert-batch.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { progressDetails, STATUS_LABELS, TYPE_LABELS } from '../../lib/jobs.ts';
import { useConvertBatch } from './useConvertBatch.ts';
import type { ConvertBatch } from './useConvertBatch.ts';

/** Columnas de formatos: los principales a la vista, el resto detrás de "+ …". */
const PRESET_COLUMNS: { title: string; main: ConversionPresetId[]; more: ConversionPresetId[] }[] =
  [
    { title: 'Video', main: ['mp4', 'webm', 'mov'], more: ['mkv', 'avi'] },
    { title: 'Animación', main: ['gif'], more: [] },
    { title: 'Solo audio', main: ['mp3', 'm4a'], more: ['wav'] },
  ];

const SHORT: Record<ConversionPresetId, string> = {
  mp4: 'MP4',
  webm: 'WebM',
  mkv: 'MKV',
  mov: 'MOV',
  avi: 'AVI',
  gif: 'GIF',
  mp3: 'MP3',
  m4a: 'M4A',
  wav: 'WAV',
};

/** Arrastrar desde el escritorio (no texto ni links). */
const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes('Files');

/**
 * Convertir (SPEC §7, mockups 2e y 2f). Varios archivos a la vez: cada uno
 * con su formato de salida. Se suben de a uno, el server analiza cada uno y
 * solo se ofrecen los formatos que tienen sentido para ese archivo. También
 * se pueden traer del historial (?origen=<id>[,<id>…]).
 */
export function ConvertPage() {
  const [options, setOptions] = useState<ConversionOptionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const batch = useConvertBatch(options);
  const [params, setParams] = useSearchParams();
  const origin = params.get('origen');
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragFiles, setDragFiles] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet('/api/conversion/options', conversionOptionsResponseSchema, controller.signal)
      .then(setOptions)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error ? error.message : 'No se pudo consultar el servidor.',
          );
        }
      });
    return () => {
      controller.abort();
    };
  }, []);

  // Links "Convertir" del historial: se suman a la lista y se limpia la URL.
  const { addFromHistory } = batch;
  useEffect(() => {
    const ids = parseOrigin(origin);
    if (ids.length === 0) return;
    addFromHistory(ids);
    setParams({}, { replace: true });
  }, [origin, addFromHistory, setParams]);

  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event) || !options) return;
    event.preventDefault();
    // El navegador no dice el tamaño hasta soltar: solo cuántos son.
    setDragFiles(event.dataTransfer.items.length);
  };
  const onDragLeave = (event: DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragFiles(null);
  };
  const onDrop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setDragFiles(null);
    batch.addFiles(event.dataTransfer.files);
  };

  const empty = batch.items.length === 0;
  const pick = () => inputRef.current?.click();

  return (
    <section className="page" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className="page-header">
        <PageTitle icon={ArrowsLeftRightIcon} title="Convertir archivos">
          {empty
            ? 'Video y audio entre MP4, WebM, MKV, MOV, AVI, GIF, MP3, M4A y WAV.'
            : 'Elegí un archivo de la lista para cambiar su formato de salida.'}
        </PageTitle>
        {!empty && (
          <div className="page-actions">
            <button type="button" className="button button-secondary" onClick={pick}>
              <PlusIcon size={16} aria-hidden="true" />
              Agregar archivos
            </button>
            <button
              type="button"
              className="button"
              disabled={batch.convertibleCount === 0 || batch.submitting}
              onClick={() => void batch.convertReady()}
            >
              <ArrowsLeftRightIcon size={16} aria-hidden="true" />
              {batch.submitting ? 'Creando…' : `Convertir ${String(batch.convertibleCount)}`}
            </button>
          </div>
        )}
      </header>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,audio/*,.mkv,.avi,.mov"
        hidden
        onChange={(e) => {
          if (e.target.files) batch.addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {loadError && (
        <div className="alert alert-error" role="alert">
          {loadError}
        </div>
      )}
      {batch.notices.length > 0 && (
        <div className="alert alert-warn notice-list" role="status">
          {batch.notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
          <button type="button" className="button button-ghost" onClick={batch.dismissNotices}>
            Entendido
          </button>
        </div>
      )}

      {(empty || dragFiles !== null) && options && (
        <Dropzone
          dragFiles={dragFiles}
          maxUploadBytes={options.maxUploadBytes}
          compact={!empty}
          onPick={pick}
        />
      )}
      {!options && !loadError && <p className="muted">Consultando el servidor…</p>}

      {!empty && options && (
        <div className="batch">
          <ul className="batch-list" aria-label="Archivos">
            {batch.items.map((item) => (
              <BatchListItem
                key={item.id}
                item={item}
                selected={batch.selected?.id === item.id}
                onSelect={() => {
                  batch.select(item.id);
                }}
              />
            ))}
          </ul>
          {batch.selected && (
            <ItemDetail
              key={batch.selected.id}
              item={batch.selected}
              batch={batch}
              limits={options.gif}
            />
          )}
        </div>
      )}
    </section>
  );
}

function Dropzone({
  dragFiles,
  maxUploadBytes,
  compact,
  onPick,
}: {
  dragFiles: number | null;
  maxUploadBytes: number;
  compact: boolean;
  onPick: () => void;
}) {
  const dragging = dragFiles !== null;
  return (
    <div
      className={`dropzone ${dragging ? 'dropzone-active' : ''} ${compact ? 'dropzone-compact' : ''}`}
    >
      {dragging ? (
        <>
          <ArrowDownIcon size={26} aria-hidden="true" className="dropzone-icon" />
          <span className="dropzone-title">
            Soltá para agregar {dragFiles === 1 ? 'el archivo' : `${String(dragFiles)} archivos`}
          </span>
          <span className="small muted">
            Máximo {formatBytes(maxUploadBytes)} por archivo: los más grandes no se suben.
          </span>
        </>
      ) : (
        <>
          <FilesIcon size={26} aria-hidden="true" className="dropzone-icon" />
          <span className="dropzone-title">Arrastrá uno o varios archivos acá</span>
          <span className="small muted">
            O elegí del <Link to="/historial">historial</Link>. Máximo {formatBytes(maxUploadBytes)}{' '}
            por archivo.
          </span>
          <button type="button" className="button" onClick={onPick}>
            Elegir archivos
          </button>
        </>
      )}
    </div>
  );
}

/** Etiqueta de estado de un ítem: el formato elegido mientras se puede elegir. */
function ItemTag({ item }: { item: ConvertItem }) {
  if (item.status === 'failed') return <span className="badge badge-error">Falló</span>;
  if (item.status === 'uploading') return <span className="badge">Subiendo</span>;
  if (item.status === 'analyzing') return <span className="badge">Analizando</span>;
  if (item.status === 'ready') {
    return <span className="badge badge-accent">{formatTag(item.preset, item.maxHeight)}</span>;
  }
  const job = item.job;
  if (!job || isActiveStatus(job.status)) {
    return <span className="badge">{formatTag(item.preset, item.maxHeight)}</span>;
  }
  const tone = job.status === 'done' ? 'badge-ok' : job.status === 'failed' ? 'badge-error' : '';
  return <span className={`badge ${tone}`}>{STATUS_LABELS[job.status]}</span>;
}

function BatchListItem({
  item,
  selected,
  onSelect,
}: {
  item: ConvertItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const job = item.job;
  const failed = item.status === 'failed' || job?.status === 'failed';
  const uploadPercent =
    item.status === 'uploading' && item.sizeBytes
      ? (item.uploadedBytes / item.sizeBytes) * 100
      : null;
  const running = job?.status === 'running';
  const percent = running ? (job.progress?.percent ?? null) : null;

  let line = itemMeta(item);
  if (item.status === 'uploading' && item.sizeBytes !== null) {
    line = `Subiendo ${formatBytes(item.uploadedBytes)} de ${formatBytes(item.sizeBytes)}`;
  } else if (running) {
    line = progressDetails(job.progress)
      .filter((part) => !part.startsWith('velocidad'))
      .join(' · ');
  } else if (job?.status === 'done') {
    line = [SHORT[item.preset ?? 'mp4'], job.sizeBytes !== null ? formatBytes(job.sizeBytes) : null]
      .filter(Boolean)
      .join(' · ');
  } else if (failed) {
    line = item.error ?? job?.error ?? 'No se pudo convertir.';
  }

  return (
    <li
      className={`batch-item ${selected ? 'batch-item-selected' : ''} ${failed ? 'batch-item-failed' : ''}`}
    >
      <button
        type="button"
        className="batch-item-select"
        onClick={onSelect}
        aria-current={selected}
      >
        <span className="batch-item-line">
          <span className="batch-item-name">{item.name}</span>
          <ItemTag item={item} />
        </span>
        {(uploadPercent !== null || running) && (
          <span
            className={`meter ${uploadPercent !== null ? 'meter-muted' : ''} ${uploadPercent === null && percent === null ? 'meter-indeterminate' : ''}`}
            aria-hidden="true"
          >
            <span
              className="meter-fill"
              style={{ width: `${String(uploadPercent ?? percent ?? 0)}%` }}
            />
          </span>
        )}
        <span className={`batch-item-meta ${failed ? 'text-error' : ''}`}>{line}</span>
      </button>
      {job?.status === 'done' && (
        <a className="batch-item-download" href={`/api/jobs/${job.id}/file`} download>
          Descargar
        </a>
      )}
    </li>
  );
}

function sourceDetails(item: ConvertItem): string {
  if (!item.source) return item.sizeBytes !== null ? formatBytes(item.sizeBytes) : '';
  const { job, media } = item.source;
  return [
    TYPE_LABELS[job.type],
    formatDuration(media.durationSeconds),
    media.width !== null && media.height !== null
      ? `${String(media.width)}x${String(media.height)}`
      : null,
    [media.videoCodec, media.audioCodec].filter(Boolean).join(' + ') || null,
    item.sizeBytes !== null ? formatBytes(item.sizeBytes) : null,
  ]
    .filter((part): part is string => part !== null && part !== '—')
    .join(' · ');
}

function ItemDetail({
  item,
  batch,
  limits,
}: {
  item: ConvertItem;
  batch: ConvertBatch;
  limits: GifLimits;
}) {
  const header = (
    <div>
      <h2 className="detail-title">{item.name}</h2>
      <p className="muted small detail-meta">{sourceDetails(item)}</p>
    </div>
  );
  const removeButton = (
    <button
      type="button"
      className="button button-secondary"
      onClick={() => {
        batch.remove(item.id);
      }}
    >
      Quitar de la lista
    </button>
  );

  if (item.status === 'uploading') {
    const percent = item.sizeBytes ? (item.uploadedBytes / item.sizeBytes) * 100 : 0;
    return (
      <div className="card detail">
        {header}
        <div
          className="meter meter-muted"
          role="progressbar"
          aria-label="Subida"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <div className="meter-fill" style={{ width: `${String(percent)}%` }} />
        </div>
        <p className="small muted">
          {percent >= 100
            ? 'Analizando el archivo…'
            : item.uploadedBytes === 0
              ? 'Esperando su turno: los archivos se suben de a uno.'
              : `Subiendo ${formatBytes(item.uploadedBytes)} de ${formatBytes(item.sizeBytes ?? 0)}`}
        </p>
        <div className="row">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              batch.remove(item.id);
            }}
          >
            Cancelar subida
          </button>
        </div>
      </div>
    );
  }

  if (item.status === 'analyzing') {
    return (
      <div className="card detail">
        {header}
        <p className="muted small">Analizando el archivo…</p>
      </div>
    );
  }

  if (item.status === 'failed') {
    return (
      <div className="card detail">
        {header}
        <div className="alert alert-error" role="alert">
          {item.error ?? 'No se pudo procesar el archivo.'}
        </div>
        <div className="row">
          {item.sourceJobId && (
            <button
              type="button"
              className="button"
              onClick={() => {
                batch.reanalyze(item);
              }}
            >
              Volver a intentar
            </button>
          )}
          {removeButton}
        </div>
      </div>
    );
  }

  if (item.status === 'job') {
    const job = item.job;
    const active = isConverting(item);
    return (
      <div className="card detail">
        {header}
        <p className="small">
          Formato:{' '}
          <span className="badge badge-accent">{formatTag(item.preset, item.maxHeight)}</span>
        </p>
        {job ? (
          <JobProgress job={job} connected doneContent={<ConvertDone job={job} />} />
        ) : (
          <p className="muted small">Conectando…</p>
        )}
        {item.error && (
          <div className="alert alert-error" role="alert">
            {item.error}
          </div>
        )}
        <div className="row">
          {active && (
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                batch.cancel(item);
              }}
            >
              Cancelar
            </button>
          )}
          {job && (job.status === 'failed' || job.status === 'cancelled') && (
            <button
              type="button"
              className="button"
              onClick={() => {
                batch.retry(item);
              }}
            >
              Reintentar
            </button>
          )}
          {!active && (
            <>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  batch.convertAgain(item);
                }}
              >
                Convertir a otro formato
              </button>
              {removeButton}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <ReadyDetail
      item={item}
      batch={batch}
      limits={limits}
      header={header}
      removeButton={removeButton}
    />
  );
}

function ReadyDetail({
  item,
  batch,
  limits,
  header,
  removeButton,
}: {
  item: ConvertItem;
  batch: ConvertBatch;
  limits: GifLimits;
  header: ReactNode;
  removeButton: ReactNode;
}) {
  const source = item.source;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  if (!source) return null;
  const { media, presets } = source;
  const heights = scaleOptions(media.height);
  const problems = itemProblems(item, limits);
  const gif = item.gif;
  const readyCount = batch.items.filter((entry) => entry.status === 'ready').length;
  const set = (patch: Partial<ConvertItem>) => {
    batch.update(item.id, patch);
  };

  return (
    <div className="card detail">
      {header}

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

      <div className="preset-columns" role="radiogroup" aria-label="Formato de salida">
        {PRESET_COLUMNS.map((column) => {
          const main = column.main.filter((id) => presets.includes(id));
          const more = column.more.filter((id) => presets.includes(id));
          if (main.length + more.length === 0) return null;
          const showMore =
            expanded.has(column.title) || (item.preset !== null && more.includes(item.preset));
          const visible = showMore ? [...main, ...more] : main;
          return (
            <div key={column.title} className="preset-column">
              <span className="kicker">{column.title}</span>
              {visible.map((id) => (
                <label key={id} className="choice-card">
                  <input
                    type="radio"
                    name={`preset-${item.id}`}
                    className="visually-hidden"
                    checked={item.preset === id}
                    onChange={() => {
                      set({
                        preset: id,
                        maxHeight: CONVERSION_PRESETS[id].scalable ? item.maxHeight : null,
                      });
                    }}
                  />
                  <span className="choice-card-title">{CONVERSION_PRESETS[id].label}</span>
                  <span className="choice-card-hint">{CONVERSION_PRESETS[id].description}</span>
                </label>
              ))}
              {!showMore && more.length > 0 && (
                <button
                  type="button"
                  className="button button-ghost preset-more"
                  onClick={() => {
                    setExpanded(new Set(expanded).add(column.title));
                  }}
                >
                  + {more.map((id) => SHORT[id]).join(', ')}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {item.preset !== null && isScalable(item.preset) && heights.length > 0 && (
        <div className="detail-row">
          <span className="field-label" id={`res-${item.id}`}>
            Resolución
          </span>
          <div className="seg" role="radiogroup" aria-labelledby={`res-${item.id}`}>
            <label className="seg-opt">
              <input
                type="radio"
                name={`res-${item.id}`}
                checked={item.maxHeight === null}
                onChange={() => {
                  set({ maxHeight: null });
                }}
              />
              Mantener ({String(media.height)}p)
            </label>
            {heights.map((height) => (
              <label key={height} className="seg-opt">
                <input
                  type="radio"
                  name={`res-${item.id}`}
                  checked={item.maxHeight === height}
                  onChange={() => {
                    set({ maxHeight: height });
                  }}
                />
                {height}p
              </label>
            ))}
          </div>
        </div>
      )}

      {item.preset === 'gif' && gif && (
        <div className="gif-options">
          <div className="row">
            <label className="field">
              <span>Inicio (s)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={gif.startSeconds}
                onChange={(e) => {
                  set({ gif: { ...gif, startSeconds: Number(e.target.value) } });
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
                  set({ gif: { ...gif, endSeconds: Number(e.target.value) } });
                }}
              />
            </label>
            <label className="field">
              <span>Cuadros por segundo</span>
              <select
                value={gif.fps}
                onChange={(e) => {
                  set({ gif: { ...gif, fps: Number(e.target.value) } });
                }}
              >
                {gifFpsOptions(limits).map((fps) => (
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
                  set({ gif: { ...gif, width: Number(e.target.value) } });
                }}
              >
                {itemGifWidths(item, limits).map((width) => (
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
            s (máximo {limits.maxSeconds} s). Sin sonido.
          </p>
          {problems.map((problem) => (
            <p key={problem} className="small text-error">
              {problem}
            </p>
          ))}
        </div>
      )}

      {item.error && (
        <div className="alert alert-error" role="alert">
          {item.error}
        </div>
      )}

      <div className="detail-actions">
        {removeButton}
        {readyCount > 1 && (
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              batch.applyToAll(item.id);
            }}
          >
            Usar este formato en todos
          </button>
        )}
      </div>
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
