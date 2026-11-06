import {
  ClockCounterClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  ArrowsLeftRightIcon,
  DownloadSimpleIcon,
  FunnelSimpleIcon,
  MagnifyingGlassIcon,
  MusicNotesIcon,
  PlayIcon,
  RecordIcon,
  TrashIcon,
  TrayIcon,
  UploadSimpleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  createJobResponseSchema,
  historyRequestersResponseSchema,
  historyResponseSchema,
  jobResponseSchema,
} from '@sti-catcher/shared';
import type {
  HistoryItem,
  HistoryRequestersResponse,
  HistoryResponse,
  HistoryScope,
} from '@sti-catcher/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { apiDelete, apiGet, apiPost } from '../../api/client.ts';
import { subscribeToAllEvents, subscribeToJobsEvents } from '../../api/events.ts';
import { RowMenu } from '../../components/RowMenu.tsx';
import { PageTitle } from '../../components/PageTitle.tsx';
import type { RowMenuItem } from '../../components/RowMenu.tsx';
import { formatBytes, formatDateTime } from '../../lib/format.ts';
import { dayRange, invalidRange, ORIGIN_OPTIONS } from '../../lib/history-filters.ts';
import {
  fileDetails,
  historyActions,
  isAudioOnly,
  isImage,
  isNewJobEvent,
  siteName,
} from '../../lib/history.ts';
import { applyEventToList, PHASE_LABELS, STATUS_LABELS, TYPE_LABELS } from '../../lib/jobs.ts';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;
/** Espera tras ver un trabajo nuevo antes de volver a pedir la lista (junta varios). */
const NEW_JOB_RELOAD_MS = 400;

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
 * Tabla con acciones agrupadas y lista en vivo: D-101.
 */
export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
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

  // Valores del filtro "Usuario" (PCs que pidieron trabajos).
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

  const reload = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  const items = state.kind === 'ready' ? state.data.items : null;

  // Cambios en vivo de los trabajos visibles: progreso, terminados, expirados, borrados.
  // Se vuelve a suscribir cada vez que cambia la lista, y al conectarse el server
  // manda el estado actual de cada uno: así no se pierde un cambio que pasó
  // mientras se pedía la lista.
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

  // Un trabajo nuevo (de cualquier sección o pestaña) vuelve a pedir la primera página.
  const itemsRef = useRef<HistoryItem[]>([]);
  useEffect(() => {
    itemsRef.current = items ?? [];
  }, [items]);
  const onFirstPage = page === 1;
  useEffect(() => {
    if (!onFirstPage) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReload = () => {
      clearTimeout(timer);
      timer = setTimeout(reload, NEW_JOB_RELOAD_MS);
    };
    const unsubscribe = subscribeToAllEvents({
      onEvent: (event) => {
        if (isNewJobEvent(event, itemsRef.current)) scheduleReload();
      },
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [onFirstPage, reload]);

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

  const clearFilters = () => {
    updateParams({ desde: null, hasta: null, tipo: null, usuario: null, q: null, page: null });
    setSearchInput('');
  };

  const showRequester = scope === 'all';
  const total = state.kind === 'ready' ? state.data.total : null;

  return (
    <section className="page">
      <header className="page-header">
        <PageTitle icon={ClockCounterClockwiseIcon} title="Historial">
          Todo lo descargado, convertido y grabado. Se actualiza solo.
        </PageTitle>
      </header>

      <div className="card history-toolbar">
        <div className="history-toolbar-row">
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
          <label className="search-field">
            <MagnifyingGlassIcon size={15} aria-hidden="true" className="search-icon" />
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

        <div className="history-toolbar-row history-filters">
          <FunnelSimpleIcon size={15} aria-hidden="true" className="filters-icon" />
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
                // Ver los de otra PC solo tiene sentido en "Todos".
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
            <button type="button" className="button button-ghost" onClick={clearFilters}>
              <XIcon size={13} aria-hidden="true" />
              Limpiar filtros
            </button>
          )}
          {total !== null && (
            <span className="history-count muted" aria-live="polite">
              {total === 1 ? '1 trabajo' : `${String(total)} trabajos`}
            </span>
          )}
        </div>
        {invalidRange(from, to) && (
          <p className="small text-warn">
            «Desde» es posterior a «Hasta»: no puede haber resultados.
          </p>
        )}
      </div>

      {actionError && (
        <div className="alert alert-error" role="alert">
          {actionError}
        </div>
      )}

      {state.kind === 'error' && (
        <div className="alert alert-error" role="alert">
          {state.message}
        </div>
      )}

      {state.kind === 'ready' && state.data.items.length === 0 ? (
        <div className="empty-state">
          {filtered || q ? (
            <MagnifyingGlassIcon size={26} aria-hidden="true" />
          ) : (
            <TrayIcon size={26} aria-hidden="true" />
          )}
          <p>
            {filtered || q
              ? 'No hay trabajos que coincidan.'
              : scope === 'mine'
                ? 'Todavía no hiciste ningún trabajo desde este navegador.'
                : 'Todavía no hay trabajos.'}
          </p>
          <p className="muted">
            {filtered || q ? (
              <button type="button" className="button button-ghost" onClick={clearFilters}>
                Limpiar la búsqueda y los filtros
              </button>
            ) : (
              'Lo que descargues, conviertas o grabes aparece acá.'
            )}
          </p>
        </div>
      ) : (
        state.kind !== 'error' && (
          <>
            <div className="table-wrap">
              <table className="table history-table" aria-busy={state.kind === 'loading'}>
                <thead>
                  <tr>
                    <th>Trabajo</th>
                    <th className="col-date">Fecha</th>
                    {showRequester && <th className="col-user">Usuario</th>}
                    <th className="col-file">Archivo</th>
                    <th className="col-size">Tamaño</th>
                    <th className="col-state">Estado</th>
                    <th className="col-actions">
                      <span className="visually-hidden">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.kind === 'loading' ? (
                    <SkeletonRows columns={showRequester ? 7 : 6} />
                  ) : (
                    state.data.items.map((item) => (
                      <HistoryRow
                        key={item.id}
                        item={item}
                        showRequester={showRequester}
                        playing={playing === item.id}
                        onTogglePlay={() => {
                          setPlaying((current) => (current === item.id ? null : item.id));
                        }}
                        onConvert={() => {
                          void navigate(`/convertir?origen=${encodeURIComponent(item.id)}`);
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
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {state.kind === 'ready' && (
              <Pagination
                page={state.data.page}
                pageSize={state.data.pageSize}
                total={state.data.total}
                onPage={(next) => {
                  updateParams({ page: next === 1 ? null : String(next) });
                }}
              />
            )}
          </>
        )
      )}
    </section>
  );
}

function SkeletonRows({ columns }: { columns: number }) {
  return [0, 1, 2].map((row) => (
    <tr key={row} aria-hidden="true">
      <td>
        <div className="video-cell">
          <span className="video-thumb" />
          <span className="skeleton" />
        </div>
      </td>
      {Array.from({ length: columns - 1 }, (_, column) => (
        <td key={column} />
      ))}
    </tr>
  ));
}

type RowProps = {
  item: HistoryItem;
  showRequester: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  onConvert: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onCancel: () => void;
};

const TYPE_ICONS = {
  download: DownloadSimpleIcon,
  upload: UploadSimpleIcon,
  conversion: ArrowsLeftRightIcon,
  recording: RecordIcon,
  selftest: ArrowsClockwiseIcon,
} as const;

function HistoryRow({
  item,
  showRequester,
  playing,
  onTogglePlay,
  onConvert,
  onDelete,
  onRetry,
  onCancel,
}: RowProps) {
  const actions = historyActions(item);
  const title = item.title ?? 'Sin título';
  const fileUrl = `/api/jobs/${item.id}/file`;
  const percent = item.progress?.percent ?? null;
  const failed = item.status === 'failed';
  const TypeIcon =
    isAudioOnly(item) && item.status === 'done' ? MusicNotesIcon : TYPE_ICONS[item.type];
  const origin = item.parentTitle !== null ? `de «${item.parentTitle}»` : siteName(item.sourceUrl);
  const statusClass = item.status === 'done' ? 'badge-ok' : failed ? 'badge-error' : 'badge-muted';

  const menuItems: RowMenuItem[] = [
    ...(actions.convert
      ? [
          {
            key: 'convert',
            label: 'Convertir a otro formato',
            icon: <ArrowsLeftRightIcon size={15} />,
            onSelect: onConvert,
          },
        ]
      : []),
    ...(actions.openOriginal && item.sourceUrl
      ? [
          {
            key: 'original',
            label: 'Abrir el link original',
            icon: <ArrowSquareOutIcon size={15} />,
            href: item.sourceUrl,
            external: true,
          },
        ]
      : []),
    ...(actions.remove
      ? [
          {
            key: 'remove',
            label: 'Borrar',
            icon: <TrashIcon size={15} />,
            danger: true,
            onSelect: onDelete,
          },
        ]
      : []),
  ];

  return (
    <>
      <tr className={playing ? 'link-row-open' : undefined}>
        <td>
          <div className="video-cell">
            <span
              className={`video-thumb type-tile type-${item.type} ${failed ? 'video-thumb-error' : ''}`}
              aria-hidden="true"
            >
              {failed ? <WarningIcon size={16} /> : <TypeIcon size={16} />}
            </span>
            <div className="video-text">
              <span className="video-title" title={title}>
                {title}
              </span>
              <span className="video-meta">
                {TYPE_LABELS[item.type]}
                {origin !== null && ` · ${origin}`}
              </span>
              {failed && item.error && <span className="video-error">{item.error}</span>}
              {item.status === 'expired' && (
                <span className="video-meta">El archivo ya no está en el servidor.</span>
              )}
            </div>
          </div>
        </td>
        <td className="col-date cell-muted">{formatDateTime(item.createdAt)}</td>
        {showRequester && (
          <td className="col-user cell-muted">
            <span className="cell-ellipsis" title={item.requester ?? undefined}>
              {item.isMine ? 'Vos' : (item.requester ?? '—')}
            </span>
          </td>
        )}
        <td className="col-file cell-muted">{fileDetails(item)}</td>
        <td className="col-size cell-muted">
          {item.sizeBytes !== null && item.status !== 'expired' ? formatBytes(item.sizeBytes) : '—'}
        </td>
        <td className="col-state">
          {item.status === 'running' ? (
            <div className="state-progress">
              <div
                className={`meter ${percent === null ? 'meter-indeterminate' : ''}`}
                role="progressbar"
                aria-label={`Progreso de «${title}»`}
                aria-valuemin={0}
                aria-valuemax={100}
                {...(percent !== null ? { 'aria-valuenow': Math.round(percent) } : {})}
              >
                <div
                  className="meter-fill"
                  style={percent !== null ? { width: `${String(percent)}%` } : undefined}
                />
              </div>
              <span className="small muted">
                {item.progress ? PHASE_LABELS[item.progress.phase] : 'Iniciando'}
                {percent !== null && ` · ${percent.toFixed(0)} %`}
              </span>
            </div>
          ) : (
            <span className={`badge ${statusClass}`}>{STATUS_LABELS[item.status]}</span>
          )}
        </td>
        <td className="col-actions">
          <span className="row-actions">
            {actions.cancel && (
              <button type="button" className="button button-ghost row-cancel" onClick={onCancel}>
                Cancelar
              </button>
            )}
            {actions.retry && (
              <button type="button" className="button button-ghost" onClick={onRetry}>
                Reintentar
              </button>
            )}
            {actions.play && (
              <button
                type="button"
                className={`button button-ghost button-icon ${playing ? 'button-icon-on' : ''}`}
                aria-label={playing ? `Cerrar «${title}»` : `Reproducir «${title}»`}
                title={playing ? 'Cerrar' : 'Reproducir'}
                aria-expanded={playing}
                onClick={onTogglePlay}
              >
                {playing ? (
                  <XIcon size={16} aria-hidden="true" />
                ) : (
                  <PlayIcon size={16} aria-hidden="true" />
                )}
              </button>
            )}
            {actions.download && (
              <a
                className="button button-ghost button-icon"
                href={fileUrl}
                download
                aria-label={`Descargar «${title}»`}
                title="Descargar"
              >
                <DownloadSimpleIcon size={16} aria-hidden="true" />
              </a>
            )}
            {menuItems.length > 0 && (
              <RowMenu label={`Más acciones para «${title}»`} items={menuItems} />
            )}
          </span>
        </td>
      </tr>
      {playing && actions.play && (
        <tr className="link-subrow">
          <td colSpan={showRequester ? 7 : 6}>
            <div className="player history-player">
              {isImage(item) ? (
                <img src={`${fileUrl}?inline=1`} alt={title} />
              ) : isAudioOnly(item) ? (
                <audio controls autoPlay src={`${fileUrl}?inline=1`} />
              ) : (
                <video controls autoPlay preload="metadata" src={`${fileUrl}?inline=1`} />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
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
  if (pages <= 1 && page <= 1) return null;
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
