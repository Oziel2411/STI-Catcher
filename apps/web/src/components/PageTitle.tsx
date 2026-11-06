import type { Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/** Título de una sección: ícono (el mismo de la barra lateral), nombre y una línea de ayuda. */
export function PageTitle({
  icon: PageIcon,
  title,
  children,
}: {
  icon: Icon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <span className="page-icon" aria-hidden="true">
        <PageIcon size={22} />
      </span>
      <div>
        <h1>{title}</h1>
        {children && <p className="muted">{children}</p>}
      </div>
    </div>
  );
}
