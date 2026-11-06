import { DotsThreeIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export type RowMenuItem = {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
} & ({ onSelect: () => void } | { href: string; external?: boolean; download?: boolean });

type Position = { top: number; right: number };

/**
 * Botón «…» con un menú de acciones secundarias de una fila.
 *
 * El menú va con `position: fixed`: así no lo recorta el contenedor con scroll
 * de la tabla. Se cierra al elegir, con Escape, al tocar afuera, al hacer
 * scroll o al cambiar el tamaño de la ventana. Flechas arriba/abajo recorren
 * las opciones (patrón «menu button» de ARIA).
 */
export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }) {
  const [position, setPosition] = useState<Position | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const open = position !== null;

  const close = (focusButton: boolean) => {
    setPosition(null);
    if (focusButton) buttonRef.current?.focus();
  };

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  };

  // Si no entra abajo, se abre hacia arriba.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const button = buttonRef.current;
    if (!open || !menu || !button) return;
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - 8) {
      const top = button.getBoundingClientRect().top - menuRect.height - 4;
      if (top >= 8) menu.style.top = `${String(top)}px`;
    }
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setPosition(null);
    };
    const onScrollOrResize = (event: Event) => {
      if (event.type === 'scroll' && menuRef.current?.contains(event.target as Node)) return;
      setPosition(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const options = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    ];
    const index = options.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      options[(index + step + options.length) % options.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="button button-ghost button-icon"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
      >
        <DotsThreeIcon size={18} weight="bold" aria-hidden="true" />
      </button>
      {position && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className="row-menu"
          style={{ top: position.top, right: position.right }}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => {
            const className = `row-menu-item ${item.danger ? 'row-menu-danger' : ''}`;
            const content = (
              <>
                <span className="row-menu-icon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </>
            );
            return 'href' in item ? (
              <a
                key={item.key}
                role="menuitem"
                tabIndex={-1}
                className={className}
                href={item.href}
                download={item.download}
                {...(item.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                onClick={() => {
                  close(false);
                }}
              >
                {content}
              </a>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={className}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
