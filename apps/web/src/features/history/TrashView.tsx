import { ArrowCounterClockwiseIcon, TrashIcon } from '@phosphor-icons/react';
import {
  historyBulkDeleteResponseSchema,
  trashEmptyResponseSchema,
  trashResponseSchema,
} from '@sti-catcher/shared';
import type { HistoryBulkDeleteResponse, TrashItem, TrashResponse } from '@sti-catcher/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';
import { formatBytes, formatDateTime } from '../../lib/format.ts';
import { TYPE_LABELS } from '../../lib/jobs.ts';
import { trashSummary } from '../../lib/trash.ts';

type LoadState =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: TrashResponse };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

/** «1 trabajo» / «3 trabajos». */
const jobsCount = (n: number) => (n === 1 ? '1 trabajo' : `${String(n)} trabajos`);

/**
 * Papelera del historial (D-115): lo propio que se borró, con cuándo se borra
 * solo. Se restaura o se borra para siempre de a uno, de a varios o todo junto.
 * No va en vivo: se vuelve a pedir después de cada acción.
 */
export function TrashView() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet('/api/trash', trashResponseSchema, controller.signal)
      .then((data) => {
        setState({ kind: 'ready', data });
        // Solo quedan elegidos los que siguen en la papelera.
        setSelected((current) => {
          const ids = new Set(data.items.map((item) => item.id));
          const next = new Set([...current].filter((id) => ids.has(id)));
          return next.size === current.size ? current : next;
        });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setState({ kind: 'error', message: errorMessage(err) });
      });
    return () => {
      controller.abort();
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  const items = useMemo(() => (state.kind === 'ready' ? state.data.items : []), [state]);
  const summary = useMemo(() => trashSummary(items, selected), [items, selected]);
  const allSelected = items.length > 0 && summary.ids.length === items.length;

  /** Lo que no se pudo queda elegido, con el motivo. */
  const report = (result: HistoryBulkDeleteResponse, doneText: (n: number) => string) => {
    setSelected(new Set(result.failed.map((entry) => entry.id)));
    if (result.done.length > 0) setNotice(doneText(result.done.length));
    if (result.failed.length > 0) {
      const reasons = [...new Set(result.failed.map((entry) => entry.message))].join(' ');
      setError(
        `${result.failed.length === 1 ? 'Uno no se pudo' : `${String(result.failed.length)} no se pudieron`}: ${reasons}`,
      );
    }
  };

  const run = (action: Promise<void>) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    action
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
        reload();
      });
  };

  const restore = (ids: readonly string[]) => {
    if (ids.length === 0) return;
    run(
      apiPost('/api/trash/restore', historyBulkDeleteResponseSchema, { ids }).then((result) => {
        report(result, (n) =>
          n === 1
            ? 'Restaurado: está de nuevo en Mis trabajos.'
            : `${jobsCount(n)} restaurados: están de nuevo en Mis trabajos.`,
        );
      }),
    );
  };

  const purge = (ids: readonly string[], bytes: number) => {
    if (ids.length === 0) return;
    const size = bytes > 0 ? ` (${formatBytes(bytes)})` : '';
    if (
      !window.confirm(
        `¿Borrar para siempre ${jobsCount(ids.length)}${size}? Esto no se puede deshacer.`,
      )
    )
      return;
    run(
      apiPost('/api/trash/purge', historyBulkDeleteResponseSchema, { ids }).then((result) => {
        report(result, (n) => `${jobsCount(n)} ${n === 1 ? 'borrado' : 'borrados'} para siempre.`);
      }),
    );
  };

  const empty = () => {
    if (state.kind !== 'ready' || state.data.items.length === 0) return;
    const size =
      state.data.totalBytes > 0 ? ` y liberar ${formatBytes(state.data.totalBytes)}` : '';
    if (
      !window.confirm(
        `¿Vaciar la papelera${size}? Se borran para siempre ${jobsCount(state.data.items.length)}. Esto no se puede deshacer.`,
      )
    )
      return;
    run(
      apiPost('/api/trash/empty', trashEmptyResponseSchema).then(({ purged, freedBytes }) => {
        setSelected(new Set());
        setNotice(
          `Papelera vaciada: ${jobsCount(purged)} ${purged === 1 ? 'borrado' : 'borrados'}${freedBytes > 0 ? `, ${formatBytes(freedBytes)} liberados` : ''}.`,
        );
      }),
    );
  };

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  return (
    <>
      <div className="card trash-summary">
        <p>
          {state.kind === 'ready' ? (
            <>
              {state.data.items.length === 0
                ? 'La papelera está vacía.'
                : `${jobsCount(state.data.items.length)} · ${formatBytes(state.data.totalBytes)}.`}{' '}
              <span className="muted">
                Lo que borres del historial queda acá {state.data.trashDays} días y después se borra
                solo. Mientras tanto ocupa lugar en el disco.
              </span>
            </>
          ) : (
            <span className="muted">Cargando la papelera…</span>
          )}
        </p>
        <button
          type="button"
          className="button button-danger"
          disabled={busy || state.kind !== 'ready' || state.data.items.length === 0}
          onClick={empty}
        >
          <TrashIcon size={15} aria-hidden="true" />
          Vaciar la papelera
        </button>
      </div>

      {notice && (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {state.kind === 'error' && (
        <div className="alert alert-error" role="alert">
          {state.message}
        </div>
      )}

      {summary.ids.length > 0 && (
        <div className="card bulk-bar" role="region" aria-label="Trabajos elegidos de la papelera">
          <span className="bulk-count" aria-live="polite">
            {summary.ids.length === 1 ? '1 elegido' : `${String(summary.ids.length)} elegidos`}
            {summary.bytes > 0 && ` · ${formatBytes(summary.bytes)}`}
          </span>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => {
              restore(summary.ids);
            }}
          >
            <ArrowCounterClockwiseIcon size={15} aria-hidden="true" />
            Restaurar
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={busy}
            onClick={() => {
              purge(summary.ids, summary.bytes);
            }}
          >
            <TrashIcon size={15} aria-hidden="true" />
            Borrar para siempre
          </button>
          <button
            type="button"
            className="button button-ghost"
            disabled={busy}
            onClick={() => {
              setSelected(new Set());
            }}
          >
            Quitar la selección
          </button>
        </div>
      )}

      {state.kind === 'ready' && items.length > 0 && (
        <div className="table-wrap">
          <table className="table history-table trash-table">
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Elegir todo lo de la papelera"
                    title="Elegir todo"
                    checked={allSelected}
                    ref={(input) => {
                      if (input) input.indeterminate = summary.ids.length > 0 && !allSelected;
                    }}
                    onChange={() => {
                      setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));
                    }}
                  />
                </th>
                <th>Trabajo</th>
                <th className="col-date">Borrado</th>
                <th className="col-date">Se borra solo</th>
                <th className="col-size">Tamaño</th>
                <th className="col-actions">
                  <span className="visually-hidden">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <TrashRow
                  key={item.id}
                  item={item}
                  selected={selected.has(item.id)}
                  busy={busy}
                  onToggle={() => {
                    toggle(item.id);
                  }}
                  onRestore={() => {
                    restore([item.id]);
                  }}
                  onPurge={() => {
                    purge([item.id], item.trashBytes ?? 0);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function TrashRow({
  item,
  selected,
  busy,
  onToggle,
  onRestore,
  onPurge,
}: {
  item: TrashItem;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const title = item.title ?? 'Sin título';
  return (
    <tr>
      <td className="col-check">
        <input
          type="checkbox"
          aria-label={`Elegir «${title}»`}
          checked={selected}
          onChange={onToggle}
        />
      </td>
      <td>
        <div className="video-text">
          <span className="video-title" title={title}>
            {title}
          </span>
          <span className="video-meta">
            {TYPE_LABELS[item.type]} ·{' '}
            {item.trashKind === 'file'
              ? 'se borró el archivo (el trabajo sigue en el historial)'
              : 'se borró el trabajo'}
            {item.trashKind === 'job' && item.trashBytes === null && ', no tenía archivo'}
          </span>
        </div>
      </td>
      <td className="col-date cell-muted">{formatDateTime(item.trashedAt)}</td>
      <td className="col-date cell-muted">{formatDateTime(item.purgeAt)}</td>
      <td className="col-size cell-muted">
        {item.trashBytes !== null ? formatBytes(item.trashBytes) : '—'}
      </td>
      <td className="col-actions">
        <span className="row-actions">
          <button type="button" className="button button-ghost" disabled={busy} onClick={onRestore}>
            Restaurar
          </button>
          <button
            type="button"
            className="button button-ghost button-icon"
            aria-label={`Borrar para siempre «${title}»`}
            title="Borrar para siempre"
            disabled={busy}
            onClick={onPurge}
          >
            <TrashIcon size={16} aria-hidden="true" />
          </button>
        </span>
      </td>
    </tr>
  );
}
