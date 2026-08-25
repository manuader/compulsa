/**
 * Espacio de nombres de las claves de hallazgo.
 *
 * Una `hallazgos.clave` es única por obra y es la que hace idempotente el
 * recompute. Pero no todas las claves las emite el motor de cómputo: el
 * bloqueo por escala (RF-201) lo emite el pipeline por lámina, y el motor no
 * sabe que existe. Sin esta frontera, el primer `recomputarObra` cerraría el
 * hallazgo de escala "porque ya no sale" — y la lámina quedaría bloqueada sin
 * consulta que lo explique.
 *
 * Módulo puro: sin I/O, sin DB.
 */

/** Prefijo reservado al pipeline: `escala.<laminaId>`. */
export const PREFIJO_ESCALA = 'escala.';

export function claveEscala(laminaId: string): string {
  return `${PREFIJO_ESCALA}${laminaId}`;
}

/**
 * `true` si la clave es de las que emite `computarObra()`. Solo estas las
 * concilia el recompute; las del pipeline las administra `procesarLamina`.
 */
export function esClaveDelMotor(clave: string): boolean {
  return !clave.startsWith(PREFIJO_ESCALA);
}
