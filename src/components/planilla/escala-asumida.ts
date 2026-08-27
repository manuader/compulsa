/**
 * "Este número se computó sobre una escala que nadie verificó."
 *
 * Desde la decisión 1 del plan una lámina con escala **declarada pero no
 * verificada** ya no bloquea: se analiza y se computa asumiendo esa escala, y
 * queda un supuesto no bloqueante en la bandeja. El aviso vivía solo ahí —en
 * otra pantalla— y la planilla, que es donde el arquitecto mira los números,
 * los mostraba idénticos a los de una lámina verificada contra cotas. Un
 * cómputo sobre una escala asumida puede estar 25 % afuera y nada en la fila lo
 * decía.
 *
 * El dato no necesita migración: sale de cruzar las `fuentes_json` del ítem con
 * el `escala_confiable` de sus láminas. El cruce es esta función, y está acá
 * —módulo sin `'use client'` ni imports de base— para que lo usen las dos
 * puntas: la página (Server Component) que arma las filas y la fila que pinta
 * el badge. Importar lógica de un `'use client'` desde el server la convierte
 * en una referencia de cliente y explota en runtime; importar `modoEscala` de
 * `src/lib/pipeline/procesar.ts` metería la base entera en el bundle. Por eso
 * la regla de "escala asumida" se dice acá con sus propias palabras, sobre los
 * dos campos que la definen.
 */
import type { Fuente } from '@/types/domain';

/** Lo que la planilla necesita saber de una lámina para juzgar sus números. */
export interface LaminaDeFuente {
  laminaId: string;
  /** Cómo nombrarla en el aviso: "A-04", o "Página 3" si no tiene rótulo leído. */
  etiqueta: string;
  escala: string | null;
  /** `true` si el modelo la verificó contra cotas, o el arquitecto la confirmó. */
  escalaConfiable: boolean;
  /**
   * Qué clase de lámina es. Solo se mira si es `'planilla'`: los números de una
   * tabla se transcriben, no se miden, así que su escala no los afecta.
   */
  tipo: string | null;
}

/** La lámina sin verificar sobre la que se computó un ítem. */
export interface EscalaAsumida {
  laminaId: string;
  etiqueta: string;
  /** La escala con la que se computó; `null` si la lámina ni siquiera la declara. */
  escala: string | null;
}

/**
 * La primera lámina **sin escala verificada** entre las fuentes del ítem, o
 * `null` si todas están verificadas (o si el ítem no tiene fuentes: uno cargado
 * a mano no se computó sobre ninguna escala).
 *
 * Se mira `escalaConfiable` y no "tiene escala declarada": una lámina sin
 * ninguna escala no debería tener ítems —el pipeline la bloquea y le saca las
 * entidades—, pero si por una corrida vieja quedó uno colgado, callarlo sería
 * el mismo silencio que esto viene a romper. El texto del aviso distingue los
 * dos casos.
 *
 * **Las planillas quedan afuera, y no es una excepción de conveniencia.** Una
 * planilla de carpinterías casi nunca declara escala y desde el arreglo de la
 * revisión final se analiza igual: sus filas producen aberturas con el ancho y
 * el alto **escritos en la tabla**. Ese número no se computó sobre ninguna
 * escala —no se midió, se transcribió—, así que avisar que "se computó sin una
 * escala verificada" sería una advertencia falsa sobre el dato más confiable de
 * la obra, y de las que enseñan a ignorar el badge. Si el ítem además se apoya
 * en un plano sin verificar, ese plano es otra fuente y el aviso sale por él.
 *
 * Una fuente que apunta a una lámina que ya no está en la obra se ignora: no
 * hay nada que nombrar, y el ítem tiene su propio aviso ("perdió la entidad que
 * lo respaldaba") por otro lado.
 */
export function escalaAsumidaDelItem(
  fuentes: readonly Fuente[],
  laminas: ReadonlyMap<string, LaminaDeFuente>,
): EscalaAsumida | null {
  for (const fuente of fuentes) {
    const lamina = laminas.get(fuente.laminaId);
    if (lamina === undefined || lamina.escalaConfiable || lamina.tipo === 'planilla') continue;
    return { laminaId: lamina.laminaId, etiqueta: lamina.etiqueta, escala: lamina.escala };
  }
  return null;
}

/** El aviso, en es-AR: qué lámina, con qué escala y qué falta hacer. */
export function textoEscalaAsumida(asumida: EscalaAsumida): string {
  const cuerpo =
    asumida.escala === null
      ? 'se computó sin una escala verificada'
      : `se computó asumiendo ${asumida.escala}, sin verificar contra cotas`;
  return `${asumida.etiqueta}: ${cuerpo}. Confirmala o corregila en la lámina.`;
}
