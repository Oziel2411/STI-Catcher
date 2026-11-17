/**
 * Instalador de un clic de la CA de la red (D-110): un `.cmd` con el
 * certificado adentro. Se pide permiso de administrador, agrega la CA al
 * almacén «Entidades de certificación raíz de confianza» del equipo (Chrome
 * y Edge lo usan) y, si hay Firefox, activa la política para que también
 * confíe en ese almacén.
 *
 * Solo ASCII: la consola de Windows abre los `.cmd` con la página de códigos
 * del sistema, y un acento se vería mal.
 */

export class InvalidCertificateError extends Error {
  override name = 'InvalidCertificateError';
}

const BEGIN = '-----BEGIN CERTIFICATE-----';
const END = '-----END CERTIFICATE-----';
const BASE64_LINE = /^[A-Za-z0-9+/=]+$/;

/**
 * Las líneas base64 de un PEM con un solo certificado. Valida cada línea: van
 * a parar a un `echo` del `.cmd`, y un carácter como `&` o `)` lo rompería.
 */
export function pemBodyLines(pem: string): string[] {
  const lines = pem
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines[0] !== BEGIN || lines.at(-1) !== END) {
    throw new InvalidCertificateError('El archivo no es un certificado PEM.');
  }
  const body = lines.slice(1, -1).filter((line) => line !== '');
  if (body.length === 0 || !body.every((line) => BASE64_LINE.test(line))) {
    throw new InvalidCertificateError('El certificado PEM tiene caracteres inesperados.');
  }
  return body;
}

export function buildCaInstallerScript(pem: string): string {
  const body = pemBodyLines(pem);
  const lines = [
    '@echo off',
    'setlocal',
    'rem Instala la autoridad de certificacion de STI-Catcher (red interna) en este equipo.',
    'rem Lo genera STI-Catcher. Solo agrega un certificado raiz al almacen del equipo',
    'rem y, si hay Firefox, le indica que use ese almacen.',
    'title Certificado de STI-Catcher',
    '',
    'net session >nul 2>&1',
    'if errorlevel 1 (',
    '  echo Hace falta permiso de administrador: acepta el aviso de Windows.',
    '  powershell -NoProfile -Command "Start-Process -FilePath \'%~f0\' -Verb RunAs"',
    '  exit /b',
    ')',
    '',
    'set "CRT=%TEMP%\\sti-catcher-ca-%RANDOM%.crt"',
    '> "%CRT%" (',
    `  echo ${BEGIN}`,
    ...body.map((line) => `  echo ${line}`),
    `  echo ${END}`,
    ')',
    '',
    'certutil -f -addstore Root "%CRT%" >nul',
    'set "RESULT=%ERRORLEVEL%"',
    'del "%CRT%" >nul 2>&1',
    '',
    'if exist "%ProgramFiles%\\Mozilla Firefox\\firefox.exe" (',
    '  reg add "HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox\\Certificates" /v ImportEnterpriseRoots /t REG_DWORD /d 1 /f >nul',
    ')',
    '',
    'echo.',
    'if "%RESULT%"=="0" (',
    '  echo Listo: el certificado de STI-Catcher quedo instalado.',
    '  echo Cerra el navegador del todo, volve a abrirlo y entra a STI-Catcher.',
    ') else (',
    '  echo No se pudo instalar el certificado. Error %RESULT%.',
    '  echo Pedile ayuda a Sistemas.',
    ')',
    'echo.',
    'pause',
    '',
  ];
  return lines.join('\r\n');
}
