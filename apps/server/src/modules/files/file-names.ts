/**
 * Nombre con el que el navegador guarda un archivo descargado (SPEC §8).
 *
 * En disco el archivo siempre se llama `<jobId>.<ext>`. El título solo se usa
 * acá, para `Content-Disposition`, y se limpia para que sea un nombre válido
 * en Windows: sin caracteres prohibidos ni nombres reservados, y con un largo
 * razonable. Las tildes, la ñ y los emojis se conservan: el header los
 * codifica según RFC 5987.
 */

/** Caracteres que Windows no permite en nombres de archivo, más los de control. */
// eslint-disable-next-line no-control-regex -- justamente se buscan los caracteres de control
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** CON, PRN, AUX, NUL, COM1–9, LPT1–9: reservados aunque tengan extensión. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME_CHARS = 150;

export function buildDownloadFileName(title: string | null, extension: string): string {
  const ext = extension.replace(/^\./, '').toLowerCase();
  let name = (title ?? '')
    .normalize('NFC')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows no admite nombres que terminen en punto o espacio.
    .replace(/[. ]+$/, '')
    .replace(/^[. ]+/, '');

  // Cortar por caracteres completos (Array.from), no por unidades UTF-16: un emoji no se parte.
  const chars = Array.from(name);
  if (chars.length > MAX_NAME_CHARS) name = chars.slice(0, MAX_NAME_CHARS).join('').trimEnd();

  if (name === '') name = 'archivo';
  if (RESERVED.test(name)) name = `_${name}`;
  return `${name}.${ext}`;
}
