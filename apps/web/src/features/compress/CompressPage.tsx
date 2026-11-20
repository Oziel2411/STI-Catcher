import { ArrowsInSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import {
  AUDIO_KBPS,
  COMPRESSION_PRESETS,
  conversionOptionsResponseSchema,
  isActiveStatus,
  TARGET_SIZE_MAX_MB,
  TARGET_SIZE_MIN_MB,
  TARGET_SIZE_SHORTCUTS,
} from '@sti-catcher/shared';
import type { AudioKbps, CompressionOptions, CompressionPresetId, Job } from '@sti-catcher/shared';
import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiGet } from '../../api/client.ts';
import { Dropzone } from '../../components/Dropzone.tsx';
import { JobProgress } from '../../components/JobProgress.tsx';
import { PageTitle } from '../../components/PageTitle.tsx';
import {
  encoderFor,
  estimateText,
  heightOptions,
  isCompressing,
  itemMeta,
  itemProblem,
  optionsTag,
  savingText,
} from '../../lib/compress-batch.ts';
import type { CompressItem } from '../../lib/compress-batch.ts';
import { parseOrigin } from '../../lib/convert-batch.ts';
import { isFileDrag } from '../../lib/drag.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { progressDetails, STATUS_LABELS, TYPE_LABELS } from '../../lib/jobs.ts';
import { NotifyPicker } from '../auth/NotifyPicker.tsx';
import { useNotifyChoice } from '../auth/use-notify-choice.ts';
import { useCompressBatch } from './useCompressBatch.ts';
import type { CompressBatch } from './useCompressBatch.ts';

const PRESET_GROUPS: { title: string; ids: CompressionPresetId[] }[] = [
  { title: 'Para compartir (H.264)', ids: ['share-720p', 'fast-720p', 'fast-1080p', 'screen'] },
  { title: 'Para archivar (H.265)', ids: ['archive-1080p', 'archive-original'] },
];

/**
 * Comprimir (D-108), al estilo de HandBrake: achicar videos para mandarlos
 * por mail o WhatsApp, subirlos a una plataforma o archivarlos. Varios a la
 * vez, cada uno con su preset; la estimación de tamaño se calcula acá con las
 * mismas cuentas que usa el server. También desde el historial (?origen=).
 */
export function CompressPage() {
  const [maxUploadBytes, setMaxUploadBytes] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const batch = useCompressBatch(maxUploadBytes);
  const [notify, setNotify] = useNotifyChoice('compress', false);
  const [params, setParams] = useSearchParams();
  const origin = params.get('origen');
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragFiles, setDragFiles] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet('/api/conversion/options', conversionOptionsResponseSchema, controller.signal)
      .then((options) => {
        setMaxUploadBytes(options.maxUploadBytes);
      })
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

  const { addFromHistory } = batch;
  useEffect(() => {
    const ids = parseOrigin(origin);
    if (ids.length === 0) return;
    addFromHistory(ids);
    setParams({}, { replace: true });
  }, [origin, addFromHistory, setParams]);

  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event) || maxUploadBytes === null) return;
    event.preventDefault();
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
        <PageTitle icon={ArrowsInSimpleIcon} title="Comprimir videos">
          {empty
            ? 'Achicá videos para mandarlos por mail o WhatsApp, subirlos a una plataforma o archivarlos.'
            : 'Elegí un video de la lista para cambiar cómo se comprime.'}
        </PageTitle>
        {!empty && (
          <div className="page-actions">
            <button type="button" className="button button-secondary" onClick={pick}>
              <PlusIcon size={16} aria-hidden="true" />
              Agregar videos
            </button>
            <button
              type="button"
              className="button"
              disabled={batch.compressibleCount === 0 || batch.submitting}
              onClick={() => void batch.compressReady(notify)}
            >
              <ArrowsInSimpleIcon size={16} aria-hidden="true" />
              {batch.submitting ? 'Creando…' : `Comprimir ${String(batch.compressibleCount)}`}
            </button>
          </div>
        )}
      </header>

      {!empty && (
        <NotifyPicker
          value={notify}
          onChange={setNotify}
          what="la compresión"
          hint="Si comprimís varios videos a la vez, llega un solo mail con la lista cuando terminan todos."
        />
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,.mkv,.avi,.mov"
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

      {(empty || dragFiles !== null) && maxUploadBytes !== null && (
        <Dropzone
          dragFiles={dragFiles}
          maxUploadBytes={maxUploadBytes}
          compact={!empty}
          onPick={pick}
        />
      )}
      {maxUploadBytes === null && !loadError && <p className="muted">Consultando el servidor…</p>}

      {!empty && maxUploadBytes !== null && (
        <div className="batch">
          <ul className="batch-list" aria-label="Videos">
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
            <ItemDetail key={batch.selected.id} item={batch.selected} batch={batch} />
          )}
        </div>
      )}
    </section>
  );
}

function ItemTag({ item }: { item: CompressItem }) {
  if (item.status === 'failed') return <span className="badge badge-error">Falló</span>;
  if (item.status === 'uploading') return <span className="badge">Subiendo</span>;
  if (item.status === 'analyzing') return <span className="badge">Analizando</span>;
  const label = COMPRESSION_PRESETS[item.options.preset].label;
  if (item.status === 'ready') return <span className="badge badge-accent">{label}</span>;
  const job = item.job;
  if (!job || isActiveStatus(job.status)) return <span className="badge">{label}</span>;
  const tone = job.status === 'done' ? 'badge-ok' : job.status === 'failed' ? 'badge-error' : '';
  return <span className={`badge ${tone}`}>{STATUS_LABELS[job.status]}</span>;
}

function BatchListItem({
  item,
  selected,
  onSelect,
}: {
  item: CompressItem;
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
  } else if (job?.status === 'queued') {
    line = 'En cola: se comprime un video a la vez.';
  } else if (job?.status === 'done') {
    line = savingText(item.sizeBytes, job.sizeBytes) ?? formatBytes(job.sizeBytes ?? 0);
  } else if (failed) {
    line = item.error ?? job?.error ?? 'No se pudo comprimir.';
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

function sourceDetails(item: CompressItem): string {
  if (!item.source) return item.sizeBytes !== null ? formatBytes(item.sizeBytes) : '';
  const { job, media } = item.source;
  return [
    TYPE_LABELS[job.type],
    formatDuration(media.durationSeconds),
    media.width !== null && media.height !== null
      ? `${String(media.width)}x${String(media.height)}`
      : null,
    media.frameRate !== null ? `${String(Math.round(media.frameRate))} fps` : null,
    [media.videoCodec, media.audioCodec].filter(Boolean).join(' + ') || null,
    item.sizeBytes !== null ? formatBytes(item.sizeBytes) : null,
  ]
    .filter((part): part is string => part !== null && part !== '—')
    .join(' · ');
}

function ItemDetail({ item, batch }: { item: CompressItem; batch: CompressBatch }) {
  // Uno solo relleno por pantalla (D-112): mientras «Comprimir N» tenga algo,
  // ese es el principal y las acciones de un video van de contorno.
  const itemAction = batch.compressibleCount === 0 ? 'button' : 'button button-secondary';
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
            ? 'Analizando el video…'
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
        <p className="muted small">Analizando el video…</p>
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
              className={itemAction}
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
    const active = isCompressing(item);
    return (
      <div className="card detail">
        {header}
        <p className="small">
          Opciones: <span className="badge badge-accent">{optionsTag(item.options)}</span>
        </p>
        {job?.status === 'queued' && (
          <p className="small muted">
            En cola. El servidor comprime un video a la vez para no frenar a los demás.
          </p>
        )}
        {job ? (
          <JobProgress
            job={job}
            connected
            doneContent={
              <CompressDone job={job} originalBytes={item.sizeBytes} className={itemAction} />
            }
          />
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
              className={itemAction}
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
                  batch.compressAgain(item);
                }}
              >
                Comprimir de otra forma
              </button>
              {removeButton}
            </>
          )}
        </div>
      </div>
    );
  }

  return <ReadyDetail item={item} batch={batch} header={header} removeButton={removeButton} />;
}

function ReadyDetail({
  item,
  batch,
  header,
  removeButton,
}: {
  item: CompressItem;
  batch: CompressBatch;
  header: ReactNode;
  removeButton: ReactNode;
}) {
  const source = item.source;
  if (!source) return null;
  const { options } = item;
  const preset = COMPRESSION_PRESETS[options.preset];
  const set = (patch: Partial<CompressionOptions>) => {
    batch.update(item.id, { options: { ...options, ...patch } });
  };
  const heights = heightOptions(item);
  const problem = itemProblem(item);
  const estimate = estimateText(item);
  const slowHevc = preset.codec === 'hevc' && encoderFor(source, options) === 'cpu';
  const readyCount = batch.items.filter((entry) => entry.status === 'ready').length;
  const presetHeight =
    preset.maxHeight !== null
      ? Math.min(preset.maxHeight, source.media.height ?? Infinity)
      : source.media.height;

  return (
    <div className="card detail">
      {header}

      <div className="preset-columns" role="radiogroup" aria-label="Preset">
        {PRESET_GROUPS.map((group) => (
          <div key={group.title} className="preset-column">
            <span className="kicker">{group.title}</span>
            {group.ids.map((id) => (
              <label key={id} className="choice-card">
                <input
                  type="radio"
                  name={`preset-${item.id}`}
                  className="visually-hidden"
                  checked={options.preset === id}
                  onChange={() => {
                    set({ preset: id, maxHeight: null });
                  }}
                />
                <span className="choice-card-title">{COMPRESSION_PRESETS[id].label}</span>
                <span className="choice-card-hint">{COMPRESSION_PRESETS[id].description}</span>
              </label>
            ))}
          </div>
        ))}
      </div>

      <div className="detail-row">
        <span className="field-label" id={`mode-${item.id}`}>
          Tamaño
        </span>
        <div className="seg" role="radiogroup" aria-labelledby={`mode-${item.id}`}>
          <label className="seg-opt">
            <input
              type="radio"
              name={`mode-${item.id}`}
              checked={options.target.mode === 'quality'}
              onChange={() => {
                set({ target: { mode: 'quality' } });
              }}
            />
            Calidad del preset
          </label>
          {TARGET_SIZE_SHORTCUTS.map((shortcut) => (
            <label key={shortcut.id} className="seg-opt">
              <input
                type="radio"
                name={`mode-${item.id}`}
                checked={
                  options.target.mode === 'size' && options.target.megabytes === shortcut.megabytes
                }
                onChange={() => {
                  set({ target: { mode: 'size', megabytes: shortcut.megabytes } });
                }}
              />
              {shortcut.label} ({shortcut.megabytes} MB)
            </label>
          ))}
        </div>
        <label className="field field-inline">
          <span>Que pese como mucho (MB)</span>
          <input
            type="number"
            min={TARGET_SIZE_MIN_MB}
            max={TARGET_SIZE_MAX_MB}
            step={1}
            value={options.target.mode === 'size' ? options.target.megabytes : ''}
            placeholder="—"
            onChange={(e) => {
              const value = Number(e.target.value);
              if (e.target.value === '' || !Number.isFinite(value)) {
                set({ target: { mode: 'quality' } });
                return;
              }
              const megabytes = Math.min(TARGET_SIZE_MAX_MB, Math.max(TARGET_SIZE_MIN_MB, value));
              set({ target: { mode: 'size', megabytes } });
            }}
          />
        </label>
      </div>

      {heights.length > 0 && (
        <div className="detail-row">
          <span className="field-label" id={`res-${item.id}`}>
            Resolución
          </span>
          <div className="seg" role="radiogroup" aria-labelledby={`res-${item.id}`}>
            <label className="seg-opt">
              <input
                type="radio"
                name={`res-${item.id}`}
                checked={options.maxHeight === null}
                onChange={() => {
                  set({ maxHeight: null });
                }}
              />
              La del preset{presetHeight !== null ? ` (${String(presetHeight)}p)` : ''}
            </label>
            {heights.map((height) => (
              <label key={height} className="seg-opt">
                <input
                  type="radio"
                  name={`res-${item.id}`}
                  checked={options.maxHeight === height}
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

      {source.media.hasAudio && (
        <div className="detail-row">
          <label className="field field-inline">
            <span>Audio</span>
            <select
              value={options.audioKbps ?? ''}
              onChange={(e) => {
                set({
                  audioKbps: e.target.value === '' ? null : (Number(e.target.value) as AudioKbps),
                });
              }}
            >
              <option value="">El del preset ({preset.audioKbps} kbps)</option>
              {AUDIO_KBPS.map((kbps) => (
                <option key={kbps} value={kbps}>
                  {kbps} kbps{kbps <= 64 ? ' (alcanza para voz)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {problem ? (
        <p className="small text-error" role="alert">
          {problem}
        </p>
      ) : (
        estimate && (
          <p className="small">
            Tamaño estimado: <strong>{estimate.text}</strong>
            {item.sizeBytes !== null && (
              <span className="muted"> (el original pesa {formatBytes(item.sizeBytes)})</span>
            )}
            {options.target.mode === 'quality' && (
              <span className="muted"> · aproximado: depende mucho del video.</span>
            )}
          </p>
        )
      )}
      {!problem && estimate?.mayNotShrink && (
        <p className="small muted">
          Este video ya está bastante comprimido: con este preset puede no achicarse. Probá «Para
          compartir» o un tamaño máximo.
        </p>
      )}
      {slowHevc && (
        <p className="small muted">
          Este servidor comprime H.265 con el procesador: puede tardar más que lo que dura el video.
        </p>
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
            Usar estas opciones en todos
          </button>
        )}
      </div>
    </div>
  );
}

function CompressDone({
  job,
  originalBytes,
  className,
}: {
  job: Job;
  originalBytes: number | null;
  className: string;
}) {
  const saving = savingText(originalBytes, job.sizeBytes);
  const grew = originalBytes !== null && job.sizeBytes !== null && job.sizeBytes >= originalBytes;
  const details = [
    job.resolution,
    [job.videoCodec, job.audioCodec].filter(Boolean).join(' + '),
  ].filter((part): part is string => part !== null && part !== '');
  return (
    <>
      <div className="row">
        <a className={className} href={`/api/jobs/${job.id}/file`} download>
          Descargar
        </a>
        <Link className="button button-secondary" to="/historial">
          Ver en el historial
        </Link>
        <span className="muted small">{[saving, ...details].filter(Boolean).join(' · ')}</span>
      </div>
      {grew && (
        <p className="small muted">
          No se achicó: el original ya estaba muy comprimido. Probá otro preset o un tamaño máximo.
        </p>
      )}
    </>
  );
}
