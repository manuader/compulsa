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

/**
 * Prefijo de las inconsistencias que levanta el motor de deducción (§11):
 * `deduccion.continuidad.<nombre>.<campo>` y `deduccion.cotas.<sobre>`.
 *
 * **No** está protegido, y es a propósito: `recomputarObra` corre `deducir()` en
 * la misma pasada que `computarObra()` y le pasa sus inconsistencias al mismo
 * `sincronizarHallazgos`. Para el conciliador son claves emitidas como
 * cualquier otra: si la contradicción sigue, la consulta se actualiza; si la
 * documentación deja de contradecirse, la consulta se cierra sola. Protegerlas
 * las dejaría abiertas para siempre.
 *
 * El prefijo se exporta igual porque la bandeja de deducciones necesita
 * distinguirlas del resto de las consultas de obra.
 */
export const PREFIJO_DEDUCCION = 'deduccion.';

export function claveEscala(laminaId: string): string {
  return `${PREFIJO_ESCALA}${laminaId}`;
}

/**
 * `true` si la clave es de las que emite el recompute —`computarObra()` o el
 * motor de deducción—. Solo estas las concilia; las del pipeline (el bloqueo por
 * escala) las administra `procesarLamina`.
 */
export function esClaveDelMotor(clave: string): boolean {
  return !clave.startsWith(PREFIJO_ESCALA);
}

/** `true` si la consulta la levantó el motor de deducción, no el de cómputo. */
export function esClaveDeDeduccion(clave: string): boolean {
  return clave.startsWith(PREFIJO_DEDUCCION);
}
