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

/**
 * Prefijo reservado a la doble pasada (RF-306): `verificacion.<claveItem>`.
 *
 * Protegido igual que el de escala, y por el mismo motivo: estas consultas las
 * emite `verificarComputo()` comparando dos extracciones, no el motor. Si el
 * recompute las conciliara, la primera corrida posterior a una verificación las
 * cerraría "porque ya no salen" y el arquitecto perdería el aviso de que dos
 * lecturas de la misma lámina no coinciden. Las abre y las cierra la
 * verificación siguiente.
 */
export const PREFIJO_VERIFICACION = 'verificacion.';

/**
 * Prefijo reservado al **cruce del expediente**: `cruce.conflicto.<huella>`.
 *
 * Protegido igual que el de escala y el de la doble pasada, y por el mismo
 * motivo: estas consultas las abre `aplicarCruce()` comparando lo que dicen dos
 * láminas distintas, no el motor de cómputo. Sin la protección, el primer
 * `recomputarObra` posterior al cruce las cerraría "porque ya no salen" —y el
 * cruce corre **antes** del recompute final de la misma corrida, así que el
 * aviso de contradicción moría a los milisegundos de nacer, sin que el
 * arquitecto lo viera nunca. Las abre y las cierra el cruce siguiente.
 */
export const PREFIJO_CRUCE = 'cruce.';

/** `cruce.conflicto.<huella>`: la contradicción que el cruce encontró (§17). */
export function claveConflictoCruce(huella: string): string {
  return `${PREFIJO_CRUCE}conflicto.${huella}`;
}

export function claveEscala(laminaId: string): string {
  return `${PREFIJO_ESCALA}${laminaId}`;
}

/**
 * La otra consulta de escala de una lámina: **la relectura del rótulo
 * contradice la escala que está confirmada** (`escala.<laminaId>.rotulo`).
 *
 * Va en una clave propia y no en `escala.<laminaId>` porque las dos pueden
 * convivir con estados distintos: la de siempre está cerrada —el arquitecto ya
 * confirmó o corrigió la escala, y por eso mismo `upsertHallazgoEscala` no la
 * reabre— y esta nace después, cuando un re-análisis lee otra cosa. Comparte el
 * prefijo `escala.` a propósito: así el recompute no la concilia (`esClaveDelMotor`)
 * y la bandeja la trata como lo que es, una consulta de escala con su botón
 * «Confirmar escala». Por eso el id de la lámina va **antes** del sufijo: el
 * lector de la bandeja se queda con el primer segmento.
 */
export function claveEscalaRotulo(laminaId: string): string {
  return `${PREFIJO_ESCALA}${laminaId}.rotulo`;
}

export function claveVerificacion(claveItem: string): string {
  return `${PREFIJO_VERIFICACION}${claveItem}`;
}

/**
 * `true` si la clave es de las que emite el recompute —`computarObra()` o el
 * motor de deducción—. Solo estas las concilia; las del pipeline (el bloqueo por
 * escala, la doble pasada y las contradicciones del cruce) las administran
 * `procesarLamina`, `verificarComputo` y `aplicarCruce`.
 */
export function esClaveDelMotor(clave: string): boolean {
  return (
    !clave.startsWith(PREFIJO_ESCALA) &&
    !clave.startsWith(PREFIJO_VERIFICACION) &&
    !clave.startsWith(PREFIJO_CRUCE)
  );
}

/** `true` si la consulta la levantó la doble pasada. La pantalla las agrupa. */
export function esClaveDeVerificacion(clave: string): boolean {
  return clave.startsWith(PREFIJO_VERIFICACION);
}

/** `true` si la consulta la levantó el motor de deducción, no el de cómputo. */
export function esClaveDeDeduccion(clave: string): boolean {
  return clave.startsWith(PREFIJO_DEDUCCION);
}
