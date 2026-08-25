/**
 * Gate de aprobación de un rubro (RF-404).
 *
 * "Ningún hueco puede quedar sin estado resuelto antes de aprobar el cómputo
 * del rubro afectado": mientras exista un hallazgo bloqueante **abierto** de
 * ese rubro, el cómputo no pasa de `revision` a `aprobado` — y sin cómputo
 * aprobado no arranca la compulsa.
 *
 * Resolver no es tapar: `respondido` (el arquitecto contestó) y `descartado`
 * (no aplica) liberan; `abierto` no. Los hallazgos de otros rubros y los de
 * obra (rubro `null`, como los sanity checks) no frenan a este rubro.
 *
 * Módulo puro: recibe los hallazgos ya leídos, no toca la base.
 */
import type { EstadoHallazgo, RubroId } from '@/types/domain';

/** Lo mínimo que el gate necesita saber de un hallazgo. */
export interface HallazgoParaGate {
  rubro: RubroId | null;
  bloqueante: boolean;
  estado: EstadoHallazgo;
}

export interface ResultadoGate {
  /** `true` si el rubro se puede aprobar. */
  ok: boolean;
  /** Cuántos hallazgos bloqueantes abiertos quedan en el rubro. */
  bloqueantes: number;
}

export function puedeAprobarRubro(
  rubro: RubroId,
  hallazgos: readonly HallazgoParaGate[],
): ResultadoGate {
  const bloqueantes = hallazgos.filter(
    (hallazgo) => hallazgo.rubro === rubro && hallazgo.bloqueante && hallazgo.estado === 'abierto',
  ).length;

  return { ok: bloqueantes === 0, bloqueantes };
}
