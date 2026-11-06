import {
  DownloadSimpleIcon,
  FilmStripIcon,
  MagnifyingGlassIcon,
  TrayIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { CONVERSION_PRESETS, conversionOptionsResponseSchema } from '@sti-catcher/shared';
import type {
  ConversionPresetId,
  GifLimits,
  Job,
  ProbeResponse,
  VideoMode,
} from '@sti-catcher/shared';
import { useEffect, useState } from 'react';
import type { SubmitEvent } from 'react';
import { apiGet } from '../../api/client.ts';
import { PageTitle } from '../../components/PageTitle.tsx';
import { gifFpsOptions, gifWidthOptions } from '../../lib/convert.ts';
import {
  editableChecked,
  FORMAT_GROUPS,
  formatLabel,
  itemProblems,
  parseLinks,
  presetAvailable,
  presetShortName,
  resultJob,
  rowError,
  rowState,
  startTargets,
} from '../../lib/download-batch.ts';
import type { DownloadItem, RowState } from '../../lib/download-batch.ts';
import { codecNotices, codecsLabel, resolutionLabel } from '../../lib/download.ts';
import type { CodecNotice } from '../../lib/download.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { progressDetails } from '../../lib/jobs.ts';
import { useDownloadBatch } from './useDownloadBatch.ts';
import type { DownloadBatch } from './useDownloadBatch.ts';

const MODE_LABELS: Record<VideoMode, string> = {
  compat: 'Compatibilidad máxima',
  quality: 'Máxima calidad',
  recode: 'Recodificar a H.264',
};

const isVideoPreset = (preset: ConversionPresetId) =>
  preset !== 'gif' && CONVERSION_PRESETS[preset].needs === 'video';

/** Renglones con algo que no es un link, con su texto completo (para el aviso). */
function invalidLines(text: string, invalid: { line: number }[]) {
  const lines = text.split(/\r?\n/);
  return [...new Set(invalid.map((entry) => entry.line))].map((line) => ({
    line,
    text: (lines[line - 1] ?? '').trim(),
  }));
}

/**
 * Descargar (SPEC §5, mockup 2a): se pegan uno o varios links y cada uno
 * se baja con su propio formato. Los que no son MP4/MP3/M4A se convierten
 * solos al terminar de bajar (D-093).
 */
export function DownloadPage() {
  const [limits, setLimits] = useState<GifLimits | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const batch = useDownloadBatch(limits);
  const [text, setText] = useState('');
  const [rejected, setRejected] = useState<{ line: number; text: string }[]>([]);
  const [submittedLines, setSubmittedLines] = useState(0);
  const [duplicates, setDuplicates] = useState(0);
  const [bulkPreset, setBulkPreset] = useState<ConversionPresetId>('mp4');

  useEffect(() => {
    const controller = new AbortController();
    apiGet('/api/conversion/options', conversionOptionsResponseSchema, controller.signal)
      .then((options) => {
        setLimits(options.gif);
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

  const { items } = batch;
  const pending = parseLinks(
    text,
    items.map((item) => item.url),
  ).urls.length;
  const checkedEditable = editableChecked(items).length;
  const targets = limits ? startTargets(items, limits).length : 0;
  const selectable = items.filter((item) => item.status === 'ready' || item.status === 'analyzing');
  const allChecked = selectable.length > 0 && selectable.every((item) => item.checked);

  const analyze = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = batch.addLinks(text);
    const bad = invalidLines(text, parsed.invalid);
    setRejected(bad);
    setSubmittedLines(text.split(/\r?\n/).filter((line) => line.trim() !== '').length);
    setDuplicates(parsed.duplicates);
    // Quedan en el cuadro solo los renglones que no sirvieron, para corregirlos.
    setText(bad.map((entry) => entry.text).join('\n'));
  };

  return (
    <section className="page">
      <header className="page-header">
        <PageTitle icon={DownloadSimpleIcon} title="Descargar videos">
          YouTube, Instagram, X y otros sitios. Pegá uno o varios links, uno por línea.
        </PageTitle>
      </header>

      {loadError && (
        <div className="alert alert-error" role="alert">
          {loadError}
        </div>
      )}

      <form className="card links-form" onSubmit={analyze}>
        <label className="field grow">
          <span>Links</span>
          <textarea
            className="links-input"
            rows={2}
            placeholder="https://www.youtube.com/watch?v=…"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              // Ctrl+Enter analiza (Enter solo agrega un renglón).
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </label>
        <button type="submit" className="button" disabled={pending === 0}>
          <MagnifyingGlassIcon size={14} aria-hidden="true" />
          {pending === 0
            ? 'Analizar'
            : `Analizar ${String(pending)} ${pending === 1 ? 'link' : 'links'}`}
        </button>
      </form>

      {rejected.length > 0 && (
        <div className="alert alert-error notice-list" role="alert">
          <p>
            <strong>Links que no sirven</strong>
          </p>
          <p>
            {rejected.length} de los {submittedLines} renglones no son links válidos y no se
            agregaron:
          </p>
          {rejected.map((entry) => (
            <p key={entry.line} className="small">
              renglón {entry.line} · «{entry.text}»
            </p>
          ))}
        </div>
      )}
      {duplicates > 0 && (
        <p className="muted small">
          {duplicates === 1
            ? 'Un link ya estaba en la lista y no se repitió.'
            : `${String(duplicates)} links ya estaban en la lista y no se repitieron.`}
        </p>
      )}

      {items.length === 0 ? (
        <div className="empty-state">
          <TrayIcon size={26} aria-hidden="true" />
          <p>Todavía no agregaste links.</p>
          <p className="muted small">
            Los que pegues aparecen acá para elegir el formato de cada uno.
          </p>
        </div>
      ) : (
        <>
          <div className="toolbar batch-toolbar">
            <span className="muted">
              {items.length} {items.length === 1 ? 'link' : 'links'}
            </span>
            <span className="toolbar-divider" aria-hidden="true" />
            <label className="toolbar-field">
              <span>Formato para los seleccionados</span>
              <select
                className="select-compact"
                value={bulkPreset}
                onChange={(e) => {
                  setBulkPreset(e.target.value as ConversionPresetId);
                }}
              >
                <FormatOptions />
              </select>
            </label>
            <button
              type="button"
              className="button button-secondary"
              disabled={checkedEditable === 0}
              onClick={() => {
                batch.applyToChecked(bulkPreset);
              }}
            >
              Aplicar a {checkedEditable}
            </button>
            <button
              type="button"
              className="button toolbar-end"
              disabled={targets === 0 || batch.submitting}
              onClick={() => void batch.startReady()}
              title="Los tildados que están listos; si no hay ninguno tildado, todos los listos."
            >
              <DownloadSimpleIcon size={14} aria-hidden="true" />
              {batch.submitting
                ? 'Creando…'
                : `Descargar ${String(targets)} ${targets === 1 ? 'listo' : 'listos'}`}
            </button>
          </div>

          <div className="table-wrap">
            <table className="table links-table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      aria-label="Seleccionar todos"
                      checked={allChecked}
                      disabled={selectable.length === 0}
                      onChange={(e) => {
                        batch.setAllChecked(e.target.checked);
                      }}
                    />
                  </th>
                  <th>Video</th>
                  <th className="col-format">Formato</th>
                  <th className="col-quality">Calidad</th>
                  <th className="col-state">Estado</th>
                  <th className="col-actions">
                    <span className="visually-hidden">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <LinkRow key={item.id} item={item} batch={batch} limits={limits} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function FormatOptions({ probe }: { probe?: ProbeResponse | null }) {
  return FORMAT_GROUPS.map((group) => (
    <optgroup key={group.title} label={group.title}>
      {group.ids.map((id) => (
        <option key={id} value={id} disabled={probe ? !presetAvailable(probe, id) : false}>
          {presetShortName(id)}
        </option>
      ))}
    </optgroup>
  ));
}

type RowProps = { item: DownloadItem; batch: DownloadBatch; limits: GifLimits | null };

function LinkRow({ item, batch, limits }: RowProps) {
  const state = rowState(item);
  const editable = item.status === 'ready';
  const error = rowError(item);
  const problems = limits ? itemProblems(item, limits) : [];
  const notices =
    editable && item.probe && item.preset === 'mp4'
      ? codecNotices(item.probe, item.maxHeight, item.videoMode)
      : [];
  const showGif = editable && item.preset === 'gif' && item.gif !== null;
  const subrow = showGif || notices.length > 0 || problems.length > 0;

  return (
    <>
      <tr className={`link-row ${subrow ? 'link-row-open' : ''}`}>
        <td className="col-check">
          <input
            type="checkbox"
            aria-label="Seleccionar"
            checked={item.checked}
            disabled={item.status !== 'ready' && item.status !== 'analyzing'}
            onChange={(e) => {
              batch.setChecked(item.id, e.target.checked);
            }}
          />
        </td>
        <td>
          <VideoCell item={item} state={state} error={error} />
        </td>
        <td className="col-format">
          {editable && item.probe && item.preset ? (
            <select
              className="select-compact"
              aria-label="Formato"
              value={item.preset}
              onChange={(e) => {
                batch.update(item.id, { preset: e.target.value as ConversionPresetId });
              }}
            >
              <FormatOptions probe={item.probe} />
            </select>
          ) : (
            <span className="cell-fixed">{item.preset ? formatLabel(item.preset) : '—'}</span>
          )}
        </td>
        <td className="col-quality">
          {editable && item.probe ? (
            <QualityEditor item={item} probe={item.probe} batch={batch} limits={limits} />
          ) : (
            <span className="cell-fixed">{qualityLabel(item)}</span>
          )}
        </td>
        <td className="col-state">
          <StateCell item={item} state={state} />
        </td>
        <td className="col-actions">
          <RowActions item={item} state={state} batch={batch} />
        </td>
      </tr>
      {subrow && (
        <tr className="link-subrow">
          <td />
          <td colSpan={5}>
            {showGif && item.gif && limits && (
              <GifRange item={item} batch={batch} limits={limits} />
            )}
            {problems.map((problem) => (
              <p key={problem} className="small text-error">
                {problem}
              </p>
            ))}
            {notices.map((notice) => (
              <NoticeView key={notice.kind} notice={notice} />
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function VideoCell({
  item,
  state,
  error,
}: {
  item: DownloadItem;
  state: RowState;
  error: string | null;
}) {
  const { probe } = item;
  const failed = state === 'failed' || state === 'live' || state === 'cancelled';
  const meta = probe
    ? [probe.site, probe.uploader, formatDuration(probe.durationSeconds)]
        .filter((part): part is string => part !== null && part !== '—')
        .join(' · ')
    : null;
  return (
    <div className="video-cell">
      {failed && state !== 'cancelled' ? (
        <span className="video-thumb video-thumb-error" aria-hidden="true">
          <WarningIcon size={16} />
        </span>
      ) : probe?.thumbnailUrl ? (
        // referrerPolicy: no se le avisa al sitio desde qué página interna se mira.
        <img
          className="video-thumb"
          src={probe.thumbnailUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="video-thumb" aria-hidden="true">
          <FilmStripIcon size={16} />
        </span>
      )}
      <div className="video-text">
        {probe ? (
          <span className="video-title" title={probe.title}>
            {probe.title}
          </span>
        ) : state === 'analyzing' ? (
          <span className="skeleton" aria-hidden="true" />
        ) : null}
        {probe && meta ? (
          <span className="video-meta">{meta}</span>
        ) : (
          <span className="video-url" title={item.url}>
            {item.url}
          </span>
        )}
        {error && state !== 'ready' && <span className="video-error">{error}</span>}
      </div>
    </div>
  );
}

function qualityLabel(item: DownloadItem): string {
  const { preset } = item;
  if (!preset) return '—';
  if (preset === 'gif') {
    return item.gif ? `${String(item.gif.width)} px · ${String(item.gif.fps)} cuadros/s` : '—';
  }
  if (!isVideoPreset(preset)) return '—';
  const height = item.maxHeight === null ? 'Mejor disponible' : `${String(item.maxHeight)}p`;
  if (preset !== 'mp4') return height;
  const codec = item.videoMode === 'quality' ? 'codec original' : 'H.264';
  return `${height} · ${codec}`;
}

function QualityEditor({
  item,
  probe,
  batch,
  limits,
}: {
  item: DownloadItem;
  probe: ProbeResponse;
  batch: DownloadBatch;
  limits: GifLimits | null;
}) {
  const { preset } = item;
  if (!preset) return <span className="cell-fixed">—</span>;

  if (preset === 'gif') {
    if (!item.gif || !limits) return <span className="cell-fixed">—</span>;
    const gif = item.gif;
    return (
      <div className="quality-pair">
        <select
          className="select-compact"
          aria-label="Ancho del GIF"
          value={gif.width}
          onChange={(e) => {
            batch.update(item.id, { gif: { ...gif, width: Number(e.target.value) } });
          }}
        >
          {gifWidthOptions(limits, null).map((width) => (
            <option key={width} value={width}>
              {width} px
            </option>
          ))}
        </select>
        <select
          className="select-compact"
          aria-label="Cuadros por segundo"
          value={gif.fps}
          onChange={(e) => {
            batch.update(item.id, { gif: { ...gif, fps: Number(e.target.value) } });
          }}
        >
          {gifFpsOptions(limits).map((fps) => (
            <option key={fps} value={fps}>
              {fps} cuadros/s
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (!isVideoPreset(preset)) return <span className="cell-fixed">—</span>;

  const heights = (
    <select
      className="select-compact"
      aria-label="Resolución"
      value={item.maxHeight ?? ''}
      onChange={(e) => {
        batch.update(item.id, {
          maxHeight: e.target.value === '' ? null : Number(e.target.value),
        });
      }}
    >
      {probe.resolutions.length === 0 && <option value="">Mejor disponible</option>}
      {probe.resolutions.map((option) => (
        <option key={option.height} value={option.height}>
          {preset === 'mp4' ? resolutionLabel(option) : `${String(option.height)}p`}
        </option>
      ))}
    </select>
  );
  if (preset !== 'mp4') return heights;

  return (
    <div className="quality-pair">
      {heights}
      <select
        className="select-compact"
        aria-label="Codec"
        value={item.videoMode}
        onChange={(e) => {
          batch.update(item.id, { videoMode: e.target.value as VideoMode });
        }}
      >
        {(Object.keys(MODE_LABELS) as VideoMode[]).map((mode) => (
          <option
            key={mode}
            value={mode}
            disabled={mode === 'compat' && probe.maxH264Height === null}
          >
            {MODE_LABELS[mode]}
          </option>
        ))}
      </select>
    </div>
  );
}

function GifRange({
  item,
  batch,
  limits,
}: {
  item: DownloadItem;
  batch: DownloadBatch;
  limits: GifLimits;
}) {
  const gif = item.gif;
  if (!gif) return null;
  const set = (patch: Partial<typeof gif>) => {
    batch.update(item.id, { gif: { ...gif, ...patch } });
  };
  const length = gif.endSeconds - gif.startSeconds;
  return (
    <div className="gif-range">
      <label className="gif-range-field">
        <span>Inicio (s)</span>
        <input
          type="number"
          min={0}
          step={0.1}
          value={gif.startSeconds}
          onChange={(e) => {
            set({ startSeconds: Number(e.target.value) });
          }}
        />
      </label>
      <label className="gif-range-field">
        <span>Fin (s)</span>
        <input
          type="number"
          min={0}
          step={0.1}
          value={gif.endSeconds}
          onChange={(e) => {
            set({ endSeconds: Number(e.target.value) });
          }}
        />
      </label>
      <span className="muted small">
        Duración del GIF: {length > 0 ? length.toFixed(1).replace('.', ',') : '0'} s (máximo{' '}
        {limits.maxSeconds} s). Sin sonido.
      </span>
    </div>
  );
}

function StateCell({ item, state }: { item: DownloadItem; state: RowState }) {
  switch (state) {
    case 'analyzing':
      return <span className="muted">Analizando…</span>;
    case 'ready':
      return <span className="badge badge-muted">Listo para descargar</span>;
    case 'live':
      return <span className="badge badge-error">En vivo</span>;
    case 'failed':
      return <span className="badge badge-error">Falló</span>;
    case 'cancelled':
      return <span className="badge badge-muted">Cancelado</span>;
    case 'queued':
      return <span className="badge badge-muted">En cola</span>;
    case 'running':
      return (
        <Progress job={item.job} text={progressDetails(item.job?.progress ?? null).join(' · ')} />
      );
    case 'converting': {
      const target = item.preset ? presetShortName(item.preset) : '';
      const followUp = item.followUp;
      const details =
        followUp?.status === 'running' && followUp.progress?.percent != null
          ? ` · ${followUp.progress.percent.toFixed(0)} %`
          : followUp?.status === 'queued'
            ? ' · en cola'
            : '';
      return <Progress job={followUp} text={`Descargado · Convirtiendo a ${target}${details}`} />;
    }
    case 'done': {
      const result = resultJob(item);
      return (
        <span className="state-done">
          <span className="badge badge-ok">Terminado</span>
          {result?.sizeBytes != null && (
            <span className="muted small">{formatBytes(result.sizeBytes)}</span>
          )}
        </span>
      );
    }
  }
}

function Progress({ job, text }: { job: Job | null; text: string }) {
  const percent = job?.status === 'running' ? (job.progress?.percent ?? null) : null;
  return (
    <div className="state-progress">
      <div
        className={`meter ${percent === null ? 'meter-indeterminate' : ''}`}
        role="progressbar"
        aria-label="Progreso"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent !== null ? { 'aria-valuenow': Math.round(percent) } : {})}
      >
        <div
          className="meter-fill"
          style={percent !== null ? { width: `${String(percent)}%` } : undefined}
        />
      </div>
      <span className="small">{text}</span>
    </div>
  );
}

function RowActions({
  item,
  state,
  batch,
}: {
  item: DownloadItem;
  state: RowState;
  batch: DownloadBatch;
}) {
  const removeButton = (
    <button
      type="button"
      className="button button-ghost button-icon"
      aria-label="Quitar de la lista"
      title="Quitar de la lista"
      onClick={() => {
        batch.remove(item.id);
      }}
    >
      <XIcon size={14} aria-hidden="true" />
    </button>
  );
  switch (state) {
    case 'analyzing':
    case 'ready':
      return removeButton;
    case 'queued':
      return (
        <button
          type="button"
          className="button button-ghost"
          onClick={() => {
            batch.cancel(item);
          }}
        >
          Quitar
        </button>
      );
    case 'running':
    case 'converting':
      return (
        <button
          type="button"
          className="button button-ghost row-cancel"
          onClick={() => {
            batch.cancel(item);
          }}
        >
          Cancelar
        </button>
      );
    case 'done': {
      const result = resultJob(item);
      return (
        <span className="row-actions">
          {result && (
            <a
              className="button button-ghost button-icon"
              href={`/api/jobs/${result.id}/file`}
              download
              aria-label="Descargar el archivo"
              title="Descargar el archivo"
            >
              <DownloadSimpleIcon size={15} aria-hidden="true" />
            </a>
          )}
          {removeButton}
        </span>
      );
    }
    case 'failed':
    case 'live':
    case 'cancelled':
      return (
        <span className="row-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              batch.retry(item);
            }}
          >
            Reintentar
          </button>
          {removeButton}
        </span>
      );
  }
}

function NoticeView({ notice }: { notice: CodecNotice }) {
  switch (notice.kind) {
    case 'compat-downgrade':
      return (
        <p className="small text-warn">
          En {notice.requested}p este video solo está en {codecsLabel(notice.codecs)}: con
          «Compatibilidad máxima» vas a obtener {notice.h264Height}p en H.264. Para tener{' '}
          {notice.requested}p elegí «Máxima calidad» (rápido, menos compatible) o «Recodificar a
          H.264» (lento).
        </p>
      );
    case 'compat-impossible':
      return (
        <p className="small text-warn">
          No hay versión en H.264 en esta resolución ni en una menor. Elegí otra resolución, «Máxima
          calidad» o «Recodificar a H.264».
        </p>
      );
    case 'quality-codec':
      return (
        <p className="small text-warn">
          El MP4 va a quedar en {codecsLabel(notice.codecs)}, no en H.264: puede no abrir en
          reproductores o editores viejos.
        </p>
      );
    case 'recode-slow':
      return (
        <p className="small text-warn">
          Recodificar es lento: puede tardar varias veces la duración del video y usa mucha CPU del
          servidor, lo que demora los trabajos de los demás.
        </p>
      );
  }
}
