import {
  createJobResponseSchema,
  historyRequestersResponseSchema,
  historyResponseSchema,
  isActiveStatus,
  jobResponseSchema,
} from '@sti-catcher/shared';
import type {
  HistoryItem,
  HistoryRequestersResponse,
  HistoryResponse,
  HistoryScope,
} from '@sti-catcher/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiDelete, apiGet, apiPost } from '../../api/client.ts';
import { subscribeToJobsEvents } from '../../api/events.ts';
import { formatBytes, formatDateTime, formatDuration } from '../../lib/format.ts';
import { dayRange, invalidRange, ORIGIN_OPTIONS } from '../../lib/history-filters.ts';
import { applyEventToList, PHASE_LABELS, STATUS_LABELS, TYPE_LABELS } from '../../lib/jobs.ts';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Error desconocido.';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: HistoryResponse };

/**
 * Historial (SPEC §8). Los filtros, la búsqueda y la página viven en la URL
 * (?scope=all&q=…&desde=…&hasta=…&tipo=…&usuario=…&page=2): recargar o
 * compartir el link mantiene la vista. Filtros de fecha, origen y usuario: D-098.
 */
export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const scope: HistoryScope = params.get('scope') === 'all' ? 'all' : 'mine';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const from = params.get('desde');
  const to = params.get('hasta');
  const origin = params.get('tipo');
  const user = params.get('usuario');
  const filtered = Boolean(from ?? to ?? origin ?? user);
  const [requesters, setRequesters] = useState<HistoryRequestersResponse['requesters']>([]);

  const [searchInput, setSearchInput] = useState(q);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const updateParams = useCallback(
    (changes: Record<string, string | null>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(changes)) {
            if (value === null || value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // La búsqueda se aplica cuando se deja de escribir, y vuelve a la primera página.
  useEffect(() => {
    if (searchInput.trim() === q) return;
    const timer = setTimeout(() => {
      updateParams({ q: searchInput.trim(), page: null });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [searchInput, q, updateParams]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ scope, page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) query.set('q', q);
    const range = dayRange(from, to);
    if (range.from) query.set('from', range.from);
    if (range.to) query.set('to', range.to);
    if (origin) query.set('type', origin);
    if (user) query.set('user', user);
    apiGet(`/api/history?${query.toString()}`, historyResponseSchema, controller.signal)
      .then((data) => {
        setState({ kind: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: 'error', message: errorMessage(error) });
      });
    return () => {
      controller.abort();
    };
  }, [scope, q, page, reloadKey, from, to, origin, user]);

  // Valores del filtro "Usuario": cuentas, y las PCs de los trabajos de antes del login.
  useEffect(() => {
    const controller = new AbortController();
    apiGet('/api/history/requesters', historyRequestersResponseSchema, controller.signal)
      .then((data) => {
        setRequesters(data.requesters);
      })
      .catch(() => {
        // Sin la lista, el filtro queda solo con "Todos".
      });
    return () => {
      controller.abort();
    };
  }, [reloadKey]);

  const items = state.kind === 'ready' ? state.data.items : null;

  // Cambios en vivo de los trabajos visibles: progreso, terminados, expirados, borrados.
  const visibleIds = useMemo(() => (items ?? []).map((item) => item.id).join(','), [items]);
  useEffect(() => {
    if (visibleIds === '') return;
    return subscribeToJobsEvents(visibleIds.split(','), {
      onEvent: (event) => {
        setState((current) => {
          if (current.kind !== 'ready') return current;
          const nextItems = applyEventToList(current.data.items, event);
          if (nextItems === current.data.items) return current;
          const removed = current.data.items.length - nextItems.length;
          return {
            kind: 'ready',
            data: { ...current.data, items: nextItems, total: current.data.total - removed },
          };
        });
      },
    });
  }, [visibleIds]);

  const reload = () => {
    setReloadKey((key) => key + 1);
  };

  const runAction = (action: Promise<unknown>, onDone?: () => void) => {
    setActionError(null);
    action
      .then(() => onDone?.())
      .catch((error: unknown) => {
        setActionError(errorMessage(error));
      });
  };

  const remove = (item: HistoryItem) => {
    const name = item.title ?? 'este trabajo';
    if (!window.confirm(`¿Borrar «${name}»? También se borra el archivo del servidor.`)) return;
    // La lista se actualiza sola con el evento job.deleted.
    runAction(apiDelete(`/api/jobs/${item.id}`));
  };

  const retry = (item: HistoryItem) => {
    runAction(apiPost(`/api/jobs/${item.id}/retry`, createJobResponseSchema), () => {
      // El intento nuevo es un trabajo propio: aparece en "Mis trabajos", primera página.
      updateParams({ scope: null, q: null, page: null });
      setSearchInput('');
      reload();
    });
  };

  const cancel = (item: HistoryItem) => {
    runAction(apiPost(`/api/jobs/${item.id}/cancel`, jobResponseSchema));
  };

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Historial</h1>
          <p className="muted">Todo lo descargado, convertido y grabado.</p>
        </div>
        <button type="button" className="button button-secondary" onClick={reload}>
          Actualizar
        </button>
      </header>

      <div className="card toolbar">
        <div className="tabs" role="tablist" aria-label="Qué trabajos mostrar">
          {(['mine', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={scope === value}
              className={`tab ${scope === value ? 'tab-active' : ''}`}
              onClick={() => {
                updateParams({ scope: value === 'all' ? 'all' : null, page: null });
              }}
            >
              {value === 'mine' ? 'Mis trabajos' : 'Todos'}
            </button>
          ))}
        </div>
        <label className="field grow">
          <span className="visually-hidden">Buscar por título</span>
          <input
            type="search"
            placeholder="Buscar por título…"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
            }}
          />
        </label>
      </div>

      <div className="history-filters">
        <label className="filter-field">
          <span>Desde</span>
          <input
            type="date"
            value={from ?? ''}
            max={to ?? undefined}
            onChange={(e) => {
              updateParams({ desde: e.target.value, page: null });
            }}
          />
        </label>
        <label className="filter-field">
          <span>Hasta</span>
          <input
            type="date"
            value={to ?? ''}
            min={from ?? undefined}
            onChange={(e) => {
              updateParams({ hasta: e.target.value, page: null });
            }}
          />
        </label>
        <label className="filter-field">
          <span>Origen</span>
          <select
            className="select-compact"
            value={origin ?? ''}
            onChange={(e) => {
              updateParams({ tipo: e.target.value, page: null });
            }}
          >
            <option value="">Todos</option>
            {ORIGIN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>Usuario</span>
          <select
            className="select-compact"
            value={user ?? ''}
            onChange={(e) => {
              // Ver los de otra persona solo tiene sentido en "Todos".
              updateParams({
                usuario: e.target.value,
                ...(e.target.value ? { scope: 'all' } : {}),
                page: null,
              });
            }}
          >
            <option value="">Todos</option>
            {user && !requesters.some((entry) => entry.value === user) && (
              <option value={user}>{user}</option>
            )}
            {requesters.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label} ({entry.total})
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              updateParams({ desde: null, hasta: null, tipo: null, usuario: null, page: null });
            }}
          >
            Limpiar filtros
          </button>
        )}
      </div>
      {invalidRange(from, to) && (
        <p className="small text-warn">
          «Desde» es posterior a «Hasta»: no puede haber resultados.
        </p>
      )}

      {actionError && (
        <div className="alert alert-error" role="alert">
          {actionError}
        </div>
      )}

      {state.kind === 'loading' && <p className="muted">Cargando…</p>}
      {state.kind === 'error' && (
        <div className="alert alert-error" role="alert">
          {state.message}
        </div>
      )}
      {state.kind === 'ready' && state.data.items.length === 0 && (
        <p className="muted">
          {filtered
            ? 'No hay trabajos con estos filtros.'
            : q
              ? `No hay trabajos que coincidan con «${q}».`
              : scope === 'mine'
                ? 'Todavía no hiciste ningún trabajo con tu cuenta.'
                : 'Todavía no hay trabajos.'}
        </p>
      )}

      {state.kind === 'ready' && state.data.items.length > 0 && (
        <>
          <ul className="history-list">
            {state.data.items.map((item) => (
              <HistoryRow
                key={item.id}
                item={item}
                showOwner={scope === 'all'}
                playing={playing === item.id}
                onTogglePlay={() => {
                  setPlaying((current) => (current === item.id ? null : item.id));
                }}
                onDelete={() => {
                  remove(item);
                }}
                onRetry={() => {
                  retry(item);
                }}
                onCancel={() => {
                  cancel(item);
                }}
              />
            ))}
          </ul>
          <Pagination
            page={state.data.page}
            pageSize={state.data.pageSize}
            total={state.data.total}
            onPage={(next) => {
              updateParams({ page: next === 1 ? null : String(next) });
            }}
          />
        </>
      )}
    </section>
  );
}

type RowProps = {
  item: HistoryItem;
  showOwner: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onCancel: () => void;
};

const isAudioOnly = (item: HistoryItem) =>
  item.format === 'mp3' ||
  item.format === 'm4a' ||
  (item.resolution === null && item.audioCodec !== null);

function HistoryRow({
  item,
  showOwner,
  playing,
  onTogglePlay,
  onDelete,
  onRetry,
  onCancel,
}: RowProps) {
  const active = isActiveStatus(item.status);
  const hasFile = item.status === 'done';
  const fileUrl = `/api/jobs/${item.id}/file`;
  const percent = item.progress?.percent ?? null;
  const statusClass =
    item.status === 'done' ? 'badge-ok' : item.status === 'failed' ? 'badge-error' : 'badge-muted';

  const meta = [
    TYPE_LABELS[item.type],
    formatDateTime(item.createdAt),
    showOwner ? item.requester : null,
    item.format?.toUpperCase() ?? null,
    item.durationSeconds !== null ? formatDuration(item.durationSeconds) : null,
    item.resolution,
    [item.videoCodec, item.audioCodec].filter(Boolean).join(' + ') || null,
    item.sizeBytes !== null && item.status !== 'expired' ? formatBytes(item.sizeBytes) : null,
  ].filter((part): part is string => part !== null && part !== '');

  return (
    <li className="history-item">
      <div className="history-main">
        <div className="job-header">
          <span className={`badge ${statusClass}`}>{STATUS_LABELS[item.status]}</span>
          {showOwner && item.isMine && <span className="badge badge-muted">Tuyo</span>}
          <span className="history-title">{item.title ?? 'Sin título'}</span>
        </div>
        <p className="muted small">{meta.join(' · ')}</p>
        {item.parentTitle !== null && (
          <p className="small muted">Convertido de «{item.parentTitle}»</p>
        )}

        {item.status === 'running' && (
          <>
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
            <p className="small">
              {item.progress ? PHASE_LABELS[item.progress.phase] : 'Iniciando'}
              {percent !== null && ` · ${percent.toFixed(0)} %`}
            </p>
          </>
        )}
        {item.status === 'failed' && item.error && <p className="small text-error">{item.error}</p>}
        {item.status === 'expired' && (
          <p className="small muted">
            El archivo ya no está en el servidor (se borró por antigüedad o a mano).
          </p>
        )}

        {playing && hasFile && (
          <div className="player">
            {isAudioOnly(item) ? (
              <audio controls autoPlay src={`${fileUrl}?inline=1`} />
            ) : (
              <video controls autoPlay preload="metadata" src={`${fileUrl}?inline=1`} />
            )}
          </div>
        )}
      </div>

      <div className="history-actions">
        {hasFile && (
          <>
            <button type="button" className="button" onClick={onTogglePlay} aria-expanded={playing}>
              {playing ? 'Cerrar' : 'Reproducir'}
            </button>
            <a className="button button-secondary" href={fileUrl} download>
              Descargar
            </a>
            <Link
              className="button button-secondary"
              to={`/convertir?origen=${encodeURIComponent(item.id)}`}
            >
              Convertir
            </Link>
          </>
        )}
        {(item.status === 'failed' || item.status === 'cancelled') &&
          (item.type === 'download' || item.type === 'conversion') && (
            <button type="button" className="button button-secondary" onClick={onRetry}>
              Reintentar
            </button>
          )}
        {item.sourceUrl && (
          <a
            className="button button-secondary"
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir original
          </a>
        )}
        {active && item.isMine && (
          <button type="button" className="button button-danger" onClick={onCancel}>
            Cancelar
          </button>
        )}
        {!active && item.isMine && (
          <button type="button" className="button button-ghost-danger" onClick={onDelete}>
            Borrar
          </button>
        )}
      </div>
    </li>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pagination" aria-label="Páginas">
      <button
        type="button"
        className="button button-secondary"
        disabled={page <= 1}
        onClick={() => {
          onPage(page - 1);
        }}
      >
        Anterior
      </button>
      <span className="muted small">
        {from}–{to} de {total}
      </span>
      <button
        type="button"
        className="button button-secondary"
        disabled={page >= pages}
        onClick={() => {
          onPage(page + 1);
        }}
      >
        Siguiente
      </button>
    </nav>
  );
}
