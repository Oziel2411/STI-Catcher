/** Sección que todavía no está implementada (se completa en su fase). */
export function ComingSoon({ title, phase }: { title: string; phase: number }) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="muted">Disponible a partir de la Fase {phase}.</p>
    </section>
  );
}
