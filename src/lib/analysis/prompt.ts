/**
 * El texto del contexto que viaja con cada lámina al analizador.
 *
 * Vive aparte de `claude.ts` a propósito: `claude.ts` no tiene tests (los tests
 * no usan red, ver el CLAUDE.md del módulo), así que **toda la lógica que se
 * puede equivocar vive acá**, pura, sin SDK y sin I/O. `claude.ts` queda como
 * el cable: arma la llamada y pega estos strings.
 *
 * Son dos funciones y hacen dos cosas distintas:
 *
 *  - `armarContextoObra(ctx)` — lo que el modelo tiene que saber de la OBRA
 *    cuando mira UNA lámina: de qué tipo es, de qué se trata, qué otras láminas
 *    hay (dónde mirar) y qué le pide este estudio.
 *  - `textoInstrucciones(instrucciones)` — resuelve la configuración del
 *    estudio (`ConfigEstudio.instruccionesExtraccion`) a las líneas de texto
 *    que después entran por `ObraContexto.instruccionesEstudio`. La llama quien
 *    arma el contexto (el pipeline), no el provider.
 *
 * Nada de esto completa datos: el índice de láminas dice **dónde está** cada
 * cosa, no qué dice. La regla 1 del prompt (P4, no estimes) sigue mandando.
 */
import { RUBROS, type InstruccionesExtraccion, type LaminaIndice, type ObraContexto, type RubroId } from '@/types/domain';

/**
 * Cómo se nombra cada rubro en el prompt.
 *
 * Se repite el nombre de `PLANTILLAS[rubro].nombre` en vez de importarlo: este
 * módulo es hoja (solo depende de `@/types/domain`) y traer `src/lib/rubros`
 * metería el motor de cómputo entero en el grafo del provider de análisis.
 * El `satisfies` obliga a completar la tabla si aparece un rubro nuevo.
 */
const ETIQUETA_RUBRO = {
  aberturas: 'Aberturas',
  seco: 'Construcción en seco',
  pintura: 'Pintura',
  gruesa: 'Obra gruesa',
  terminaciones: 'Terminaciones',
  sanitaria: 'Instalación sanitaria',
  electrica: 'Instalación eléctrica',
  demolicion: 'Demolición',
} satisfies Record<RubroId, string>;

/** `undefined`, `''` y `'   '` son lo mismo: no hay dato. */
function limpio(texto: string | null | undefined): string | null {
  const recortado = texto?.trim() ?? '';
  return recortado === '' ? null : recortado;
}

/**
 * Una línea del índice: `- A-01 — PLANTA PB (planta)`.
 *
 * Una lámina sin código ni título no se puede nombrar, así que no entra al
 * índice (nombrarla "(sin título)" sería ruido que el modelo tiene que
 * ignorar). El tipo va entre paréntesis solo si se conoce.
 */
function lineaDeLamina(lamina: LaminaIndice): string | null {
  const nombre = [limpio(lamina.codigo), limpio(lamina.titulo)]
    .filter((parte): parte is string => parte !== null)
    .join(' — ');
  if (nombre === '') return null;
  return lamina.tipo === null ? `- ${nombre}` : `- ${nombre} (${lamina.tipo})`;
}

/**
 * El bloque de contexto de obra que se le pasa al analizador de una lámina.
 *
 * **Firma estable** (la consumen el provider de Claude y, desde T2, el
 * pipeline): recibe el `ObraContexto` tal cual y devuelve el texto ya armado.
 * Los tres campos opcionales son aditivos: un contexto que solo trae `obraId` y
 * `tipoObra` produce exactamente la línea que producía antes de todo esto.
 */
export function armarContextoObra(ctx: ObraContexto): string {
  const secciones: string[] = [`Obra de tipo: ${ctx.tipoObra}.`];

  const resumen = limpio(ctx.resumen);
  if (resumen !== null) secciones.push(`De qué se trata la obra: ${resumen}`);

  const indice = (ctx.indiceLaminas ?? [])
    .map(lineaDeLamina)
    .filter((linea): linea is string => linea !== null);
  if (indice.length > 0) {
    secciones.push(
      [
        'Otras láminas del expediente (te dicen dónde está cada cosa; no copies a esta lámina un dato que está escrito en otra):',
        ...indice,
      ].join('\n'),
    );
  }

  const instrucciones = limpio(ctx.instruccionesEstudio);
  if (instrucciones !== null) {
    secciones.push(`Instrucciones de este estudio para leer sus láminas:\n${instrucciones}`);
  }

  return secciones.join('\n\n');
}

/**
 * La configuración de extracción del estudio, resuelta a texto plano.
 *
 * `general` primero y después una línea por rubro configurado, etiquetada
 * (`Aberturas: …`) para que el modelo sepa a qué se aplica cada cosa. Si no hay
 * nada escrito devuelve `null`: el que arma el contexto deja
 * `instruccionesEstudio` afuera y el prompt queda como si el estudio nunca
 * hubiera abierto la pantalla de configuración.
 */
export function textoInstrucciones(instrucciones: InstruccionesExtraccion): string | null {
  const lineas: string[] = [];

  const general = limpio(instrucciones.general);
  if (general !== null) lineas.push(general);

  for (const rubro of RUBROS) {
    const texto = limpio(instrucciones.porRubro[rubro]);
    if (texto !== null) lineas.push(`${ETIQUETA_RUBRO[rubro]}: ${texto}`);
  }

  return lineas.length === 0 ? null : lineas.join('\n');
}
