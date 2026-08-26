/**
 * Gate de aprobación de un rubro (RF-404).
 *
 * "Ningún hueco puede quedar sin estado resuelto antes de aprobar el cómputo
 * del rubro afectado": mientras exista un hallazgo bloqueante **abierto** que
 * afecte al rubro, el cómputo no pasa de `revision` a `aprobado` — y sin
 * cómputo aprobado no arranca la compulsa.
 *
 * ## Qué afecta a un rubro
 *
 * Dos familias, y las dos cuentan:
 *
 *  - **Los del rubro** (`rubro === 'seco'`): falta la altura de un tabique, el
 *    sistema constructivo no es el de la plantilla.
 *  - **Los de obra** (`rubro === null`): no pertenecen a ningún rubro porque
 *    los afectan a **todos**. El caso vivo es el bloqueo por escala (RF-201):
 *    una lámina sin escala verificable no se midió, así que el cómputo de
 *    cualquier rubro que tocara esa lámina está incompleto. Dejar aprobar
 *    "seco" mientras una lámina sigue sin medir sería aprobar un cómputo del
 *    que falta un pedazo, y contradice lo que dicen el tablero ("bloquean la
 *    aprobación", contando todos los bloqueantes abiertos de la obra) y la
 *    bandeja ("una consulta bloqueante frena la aprobación de su rubro").
 *
 * Que un hallazgo de obra no bloquee **no** es una decisión de este módulo: si
 * un chequeo de coherencia no tiene que frenar nada, nace con
 * `bloqueante: false` (así nacen los `inconsistencia` de `sanity.ts`) y el gate
 * ni lo mira. Lo que el gate no puede hacer es ignorar un hallazgo que el
 * motor marcó como bloqueante.
 *
 * Resolver no es tapar: `respondido` (el arquitecto contestó) y `descartado`
 * (no aplica) liberan; `abierto` no. Los bloqueantes de **otro** rubro siguen
 * sin frenar a este.
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
  /** Cuántos hallazgos bloqueantes abiertos frenan a este rubro. */
  bloqueantes: number;
}

/** Un hallazgo de obra (`rubro: null`) afecta a todos los rubros. */
function afectaAlRubro(hallazgo: HallazgoParaGate, rubro: RubroId): boolean {
  return hallazgo.rubro === rubro || hallazgo.rubro === null;
}

export function puedeAprobarRubro(
  rubro: RubroId,
  hallazgos: readonly HallazgoParaGate[],
): ResultadoGate {
  const bloqueantes = hallazgos.filter(
    (hallazgo) =>
      afectaAlRubro(hallazgo, rubro) && hallazgo.bloqueante && hallazgo.estado === 'abierto',
  ).length;

  return { ok: bloqueantes === 0, bloqueantes };
}
