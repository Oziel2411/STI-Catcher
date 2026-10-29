/**
 * Texto normalizado para buscar: minúsculas y sin tildes ni diéresis, para que
 * "cancion" encuentre "Canción" y "nandu" encuentre "Ñandú".
 *
 * SQLite compara con LIKE sin distinguir mayúsculas solo en ASCII y no sabe
 * quitar tildes, así que el título normalizado se guarda en su propia columna
 * (`title_search`) y la búsqueda se normaliza igual.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escapa `%`, `_` y `\` para usar el texto dentro de un LIKE con `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
