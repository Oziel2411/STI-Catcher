/**
 * Reloj para la grabación programada (D-097).
 *
 * Con la pestaña en segundo plano, Chrome frena los `setInterval` de la
 * página (después de unos minutos, como mucho uno por minuto): un corte "a las
 * 15:30" podía llegar casi un minuto tarde. Los timers de un Worker no tienen
 * ese freno, así que el tic viene de un Worker mínimo. Si no se puede crear,
 * se usa `setInterval` (anda igual, con menos precisión en segundo plano).
 *
 * @returns función para detenerlo
 */
export function startBackgroundClock(onTick: () => void, intervalMs = 1000): () => void {
  try {
    const source = `setInterval(() => postMessage(0), ${String(intervalMs)});`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = () => {
      onTick();
    };
    return () => {
      worker.terminate();
    };
  } catch {
    const timer = setInterval(onTick, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }
}

/**
 * Pide que la pantalla no se apague mientras haya algo programado o grabando.
 * El navegador suelta el pedido si la pestaña deja de verse; se vuelve a
 * pedir cuando se ve de nuevo. No evita que Windows suspenda la PC.
 *
 * @returns función para soltarlo
 */
export function keepScreenAwake(): () => void {
  if (!('wakeLock' in navigator)) return () => undefined;
  let lock: WakeLockSentinel | null = null;
  let released = false;

  const request = () => {
    if (released || document.visibilityState !== 'visible') return;
    navigator.wakeLock
      .request('screen')
      .then((sentinel) => {
        if (released) void sentinel.release();
        else lock = sentinel;
      })
      .catch(() => {
        // Sin permiso o con batería baja: se sigue sin el pedido.
      });
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && (lock === null || lock.released)) request();
  };

  request();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisibility);
    void lock?.release();
  };
}
