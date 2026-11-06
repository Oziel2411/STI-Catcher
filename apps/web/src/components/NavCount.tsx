/** Cuántos trabajos de esta cuenta siguen en cola o en curso (nada si son cero). */
export function NavCount({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <span className="nav-count" title="En cola o en curso">
      {value}
      <span className="visually-hidden"> en curso</span>
    </span>
  );
}
