import { describe, expect, it } from 'vitest';
import { createLoginLimiter } from './login-limiter.ts';

const MINUTE = 60_000;

function setup() {
  const clock = { now: 1_000_000 };
  const limiter = createLoginLimiter({ now: () => clock.now });
  return { clock, limiter };
}

describe('createLoginLimiter', () => {
  it('5 fallidos seguidos bloquean la cuenta 15 minutos', () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 4; i++) limiter.recordFailure('a@x.ar', '10.0.0.1');
    expect(limiter.blockedFor('a@x.ar', '10.0.0.1')).toBe(0);
    limiter.recordFailure('a@x.ar', '10.0.0.1');
    expect(limiter.blockedFor('a@x.ar', '10.0.0.1')).toBe(15 * MINUTE);
    // Desde otra IP también: lo que se bloquea es la cuenta.
    expect(limiter.blockedFor('a@x.ar', '10.0.0.2')).toBe(15 * MINUTE);
    // Otra cuenta desde la misma IP sigue pudiendo.
    expect(limiter.blockedFor('b@x.ar', '10.0.0.1')).toBe(0);
    clock.now += 15 * MINUTE + 1;
    expect(limiter.blockedFor('a@x.ar', '10.0.0.1')).toBe(0);
  });

  it('un ingreso correcto reinicia el contador de la cuenta', () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i++) limiter.recordFailure('a@x.ar', '10.0.0.1');
    limiter.recordSuccess('a@x.ar');
    for (let i = 0; i < 4; i++) limiter.recordFailure('a@x.ar', '10.0.0.1');
    expect(limiter.blockedFor('a@x.ar', '10.0.0.1')).toBe(0);
  });

  it('20 fallidos de una IP en 15 minutos (con mails distintos) bloquean la IP', () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 19; i++) {
      limiter.recordFailure(`u${String(i)}@x.ar`, '10.0.0.9');
      clock.now += 10_000;
    }
    expect(limiter.blockedFor('nuevo@x.ar', '10.0.0.9')).toBe(0);
    limiter.recordFailure('u19@x.ar', '10.0.0.9');
    expect(limiter.blockedFor('nuevo@x.ar', '10.0.0.9')).toBe(15 * MINUTE);
    expect(limiter.blockedFor('nuevo@x.ar', '10.0.0.10')).toBe(0);
  });

  it('los fallidos de una IP más viejos que la ventana no cuentan', () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 19; i++) limiter.recordFailure(`u${String(i)}@x.ar`, '10.0.0.9');
    clock.now += 16 * MINUTE;
    limiter.recordFailure('otro@x.ar', '10.0.0.9');
    expect(limiter.blockedFor('nuevo@x.ar', '10.0.0.9')).toBe(0);
  });
});
