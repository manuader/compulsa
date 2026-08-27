/**
 * El único lector válido de `hallazgos.target_ref` en todo el repo.
 *
 * Un hallazgo que se responde escribiendo un dato apunta a **una entidad y sus
 * campos**. Hasta T0 apuntaba a UN campo (`{ entidadId, campo }`): responder el
 * ancho de una carpintería cerraba la consulta y al recompute siguiente
 * reaparecía otra por el alto. Desde T0 se escribe siempre en plural
 * (`{ entidadId, campos }`) y una sola tarjeta pide todo lo que falta.
 *
 * Las filas que ya estaban en la base conservan el shape viejo para siempre (no
 * hay migración de datos: las cerradas son historia y las abiertas migran solas
 * en el primer recompute, que las reescribe con `campos`). Por eso **nadie lee
 * `.campo` ni `.campos` directo**: todo pasa por acá, que normaliza los dos
 * shapes a una lista. Si ves un `targetRef.campo` en el código, es un bug.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import type { TargetRefPersistido } from '@/types/domain';

/** Sin target no hay campos: la lista vacía es la respuesta honesta. */
const SIN_CAMPOS: readonly string[] = [];

/**
 * Los campos que hay que completar para responder el hallazgo, en orden.
 *
 * `campos` manda; si no está (fila vieja), el `campo` singular es la lista de
 * uno. Sin target, o con un target sin ninguno de los dos, devuelve `[]`.
 */
export function camposDelTarget(target: TargetRefPersistido | null | undefined): string[] {
  if (!target) return [...SIN_CAMPOS];
  if (target.campos !== undefined) return [...target.campos];
  return target.campo !== undefined && target.campo !== '' ? [target.campo] : [...SIN_CAMPOS];
}
