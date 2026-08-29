/**
 * Provider de análisis real: Claude leyendo la lámina.
 *
 * La lámina viaja como **documento PDF** (la API los acepta nativamente) junto
 * con el texto ya extraído por `src/lib/pdf/texto.ts`. No mandamos la página
 * rasterizada porque el proyecto no tiene canvas (ver `src/lib/pdf/texto.ts`).
 *
 * La salida se fuerza con structured outputs sobre los mismos schemas Zod del
 * dominio (`zAnalisisLamina`): lo que vuelve ya está validado contra el contrato
 * o la llamada falla.
 *
 * **Este archivo no tiene tests automáticos** (los tests no usan red, por
 * global-constraints). Por eso es chico y está espejado sobre `mock.ts`: misma
 * interfaz, mismo shape, misma regla de "sin datos, null y lista vacía".
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { registrarAuditoria } from '@/lib/audit';
import type { LaminaInput, ObraContexto, RotuloDetectado } from '@/types/domain';
import { armarContextoObra } from './prompt';
import {
  sanearAnalisis,
  sanearRotulo,
  zAnalisisLaminaCrudo,
  zRotuloCrudo,
  type AnalisisLamina,
  type AnalysisProvider,
} from './tipos';

/** Una lámina se analiza de una sola vez; el rótulo y las entidades salen juntos. */
const MAX_LAMINAS_EN_MEMORIA = 32;

function modelo(): string {
  return process.env.ANALYSIS_MODEL ?? 'claude-sonnet-5';
}

/**
 * P4 en forma de prompt: el modelo no completa huecos. Lo que no está explícito
 * vuelve en `null` y después el motor de hallazgos lo convierte en una consulta
 * para el usuario (`src/lib/hallazgos/`).
 */
const SISTEMA = `Sos un asistente que lee láminas de proyectos de arquitectura de estudios argentinos y devuelve datos estructurados para un cómputo de materiales.

Reglas que no se negocian:

1. NO ESTIMES NADA. Si un dato no está explícito en la lámina, el campo va \`null\` y se acabó. Jamás completes una medida "razonable", ni deduzcas una altura estándar, ni redondees a un valor típico. Un dato faltante es una consulta al proyectista, no un problema tuyo que resolver.
2. Toda entidad necesita \`bbox\`: [x, y, ancho, alto] normalizado 0–1 sobre la lámina, con origen arriba a la izquierda. Si no podés ubicarla en la lámina, no la devuelvas. "Ubicarla" no quiere decir "encontrarla dibujada": la fila de una tabla es una ubicación tan buena como el contorno de un ambiente.
3. \`confianza\` es tu confianza real (0–1), no un número de cortesía.
4. \`escalaConfiable\` es \`true\` SOLO si verificaste la escala declarada contra al menos dos cotas leídas del plano, con 3 % de tolerancia. Si no pudiste verificarla, es \`false\`, y eso está bien: \`false\` es la respuesta correcta y la más común. Lo que sí importa es que devuelvas en \`escala\` **lo que el rótulo declare**, aunque no la hayas podido verificar —y \`null\` si no declara ninguna, nunca una inventada—: esa escala se le propone al usuario para que la confirme de un click.
5. Medidas en metros y metros cuadrados. Textos y nombres en español rioplatense (es-AR).
6. \`estadoReforma\`: usá \`na\` en obra nueva. En reforma o ampliación, \`existente\`, \`demoler\` o \`nueva\` según lo que la lámina indique explícitamente (rayado de demolición, referencias, etc.); si la lámina no lo dice, \`na\`.
7. Claves exactas de \`atributos\` según el tipo de entidad:
   - ambiente: superficieM2, perimetroM, alturaM, vanosM2, nivel, solado, zocalo, cielorraso, revestimiento, alturaRevestimientoM — \`nivel\` es el piso donde está el ambiente, nombrado como lo nombra el proyecto ("PB", "1º", "subsuelo"). Las cuatro terminaciones (\`solado\`, \`zocalo\`, \`cielorraso\`, \`revestimiento\`) son texto libre tal como las escribe la lámina ("porcelanato 60×60", "madera", "yeso aplicado", "cerámica"), y \`alturaRevestimientoM\` es hasta qué altura llega el revestimiento de pared, en metros.
   - abertura: tag, tipologia ('ventana' | 'puerta' | 'paño fijo'), anchoM, altoM, material, vidrio, cantidad — \`material\` y \`vidrio\` son texto libre tal como los escribe la lámina ("aluminio línea Módena", "DVH 4/9/4"). \`cantidad\` es SOLO de las filas de una planilla de carpinterías, donde la tabla dice cuántas hay de esa tipología: una abertura dibujada en una planta es una, y ahí la clave no va.
   - tabique: tipo ('durlock'), largoM, alturaM, caras
   - muro: tipo ('mamposteria'), largoM, alturaM
   - terminacion: superficieM2, ubicacion ('piso' | 'cielorraso' | 'pared'), ambiente (nombre del ambiente), material
   - tramo (un tramo de cañería): sistema ('af' | 'ac' | 'cloacal' | 'pluvial'), diametro, longitudM, material, ambiente — \`af\` es agua fría y \`ac\` agua caliente. \`diametro\` es TEXTO y va tal como está escrito, sin el símbolo ni la unidad: de "Ø110" devolvés "110", de '1/2"' devolvés "1/2". \`longitudM\` solo cuando la lámina la trae (regla 9). \`ambiente\` es el nombre del local que el tramo atraviesa o al que sirve, y va SOLO si la lámina lo deja claro.
   - accesorio (una pieza de la cañería): tipo ('codo90' | 'codo45' | 'te' | 'valvula'), sistema, diametro — \`sistema\` y \`diametro\` se escriben igual que en el tramo.
   - artefacto (inodoro, bidet, lavatorio, bacha, bañera, pileta de cocina, pileta de lavar): ambiente — el nombre del local donde está el artefacto.
   - boca (un punto de la instalación eléctrica): tipo ('toma' | 'luz' | 'caja' | 'tablero' | 'datos'), circuito — \`circuito\` es la identificación del circuito tal como la escribe la lámina ("C1", "IUG"), y va solo si está escrita.
   No inventes claves nuevas y no incluyas una clave cuyo valor no leíste.
8. Cuando la lámina no es un plano con entidades dibujadas, fijate bien qué es antes de darla por vacía:
   - **Planilla de carpinterías** (la tabla de aberturas del proyecto: una fila por tipología, con sus medidas): extraé **una entidad \`abertura\` por fila de la tabla**, con \`bbox\` = la fila. Es la lámina donde el estudio escribe las medidas que en la planta no están: saltearla es perder el dato. De cada fila devolvé **solo las claves que esa fila trae escritas** (\`tag\`, \`tipologia\`, \`anchoM\`, \`altoM\`, \`material\`, \`vidrio\`, \`cantidad\`); la clave que no está escrita no va (regla 1). \`cantidad\` es informativa y **no computa**: cuántas se compran lo dice la planta, no la planilla.
   - **Cuadro de locales** (la tabla de ambientes con sus terminaciones: una fila por local, con solado, zócalo, cielorraso, revestimiento y a veces la superficie): extraé **una entidad \`ambiente\` por fila de la tabla**, con \`bbox\` = la fila. Es la planilla de carpinterías de las terminaciones: ahí es donde el estudio escribe con qué se termina cada ambiente, y la planta no lo dice. De cada fila devolvé **solo las claves que esa fila trae escritas**.
   - **Carátula, memoria descriptiva, índice de láminas o cualquier otra lámina sin nada computable**: devolvé el rótulo que puedas leer y \`entidades: []\`.
9. **Planos de instalaciones** (sanitaria, eléctrica): las cañerías son \`tramo\`, sus piezas son \`accesorio\`, los puntos de la eléctrica son \`boca\` y los artefactos son \`artefacto\`. Dos cosas, y las dos importan:
   - **\`longitudM\` de un tramo va SOLO si la lámina la trae acotada o escrita.** Un recorrido de cañería no se mide a ojo ni se calcula con la escala — es la regla 1 aplicada justo donde más tienta romperla. Un tramo sin longitud se devuelve igual, con su sistema y su diámetro: cuánto mide se resuelve después o se le pregunta al proyectista.
   - **El \`ambiente\` de un artefacto y el de un tramo se escriben IGUAL que el nombre del ambiente en la planta** ("Baño 1", no "baño" ni "BAÑO 1"). Es lo que después deja ver que una bacha no tiene desagüe cloacal en su local; escrito distinto en cada entidad, el control no puede correr. Si el nombre del local no está claro en la lámina, la clave no va (regla 1) — pero si está, ponela.`;

/**
 * El prompt del **inventario**: el rótulo y nada más.
 *
 * Es corto a propósito y no repite ninguna de las reglas de extracción: en esta
 * pasada no hay entidades que devolver, así que las reglas de bbox, de
 * atributos y de tipos de lámina no aplican. Lo único que se comparte con
 * `SISTEMA` es la regla de la escala (regla 4 allá), porque el rótulo es
 * exactamente donde se juega, y es lo que el pipeline usa después para decidir
 * si la lámina se analiza asumiendo la escala declarada o queda bloqueada.
 */
const SISTEMA_INVENTARIO = `Sos un asistente que lee el rótulo de una lámina de un proyecto de arquitectura argentino. Esta pasada es un inventario del expediente: te interesa saber QUÉ ES esta lámina, no qué hay dibujado adentro.

Devolvé únicamente lo que el rótulo (o la carátula) diga:

1. NO ESTIMES NADA. El campo que el rótulo no trae escrito va \`null\`. No deduzcas el código de lámina de la numeración de páginas, no adivines la disciplina por el dibujo, no inventes una revisión.
2. \`escala\`: la que el rótulo DECLARA, tal como está escrita ("1:100"), y \`null\` si no declara ninguna. Es la que después se le propone al usuario para que la confirme de un click, así que copiarla mal es peor que no traerla.
3. \`escalaConfiable\` es SIEMPRE \`false\` en esta pasada: confiar en una escala exige verificarla contra al menos dos cotas del plano, y acá no estás mirando el plano.
4. \`tipoLamina\`: qué clase de lámina es (planta, corte, vista, detalle, planilla, otra). Una planilla de carpinterías o un cuadro de locales son \`planilla\`, aunque el rótulo diga otra cosa.
5. \`confianza\` es tu confianza real (0–1) en la lectura del rótulo, no un número de cortesía.
6. Textos en español rioplatense (es-AR), tal como los escribe la lámina.`;

function instruccionInventario(lamina: LaminaInput): string {
  const partes = [
    `Documento: "${lamina.documentoNombre}", página ${lamina.numeroPagina}.`,
    'Leé el rótulo de esta lámina. No extraigas entidades.',
    lamina.textoExtraido
      ? `\nTexto extraído del PDF (es literal, confiá en él por sobre lo que creas ver en el dibujo):\n---\n${lamina.textoExtraido}\n---`
      : null,
  ];
  return partes.filter((parte) => parte !== null).join('\n');
}

/**
 * Una llamada corta por lámina, **sin** pasar por el caché de `analizar()`: ese
 * caché guarda la extracción completa, y el inventario es la pasada que existe
 * para no pagarla. `effort: 'low'` porque leer un rótulo es transcribir, no
 * razonar — es lo que hace que la fase sea barata de verdad.
 */
async function pedirInventario(
  cliente: Anthropic,
  lamina: LaminaInput,
  ctx?: ObraContexto,
): Promise<RotuloDetectado> {
  const respuesta = await cliente.messages.parse({
    model: modelo(),
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: SISTEMA_INVENTARIO,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: Buffer.from(lamina.pdfBytes).toString('base64'),
            },
          },
          { type: 'text', text: instruccionInventario(lamina) },
        ],
      },
    ],
    output_config: { effort: 'low', format: zodOutputFormat(zRotuloCrudo) },
  });

  // RNF-7: `inventario_llm` es el tercero de los cuatro renglones que suman el
  // costo de una obra (`analisis_llm`, `inventario_llm`, `cruce_llm`,
  // `busqueda_llm`). El `ctx` no viaja al prompt —el índice de la obra es
  // justamente lo que esta fase construye— pero sí trae el `obraId`: sin él la
  // fila queda sin obra y el inventario, que es una llamada por lámina, no se
  // ve en la auditoría del estudio, que es donde se responde cuánto costó
  // analizar una obra.
  await registrarAuditoria({
    obraId: ctx?.obraId,
    actorTipo: 'agente',
    actorNombre: 'analisis-claude',
    accion: 'inventario_llm',
    targetRef: `laminas:${lamina.laminaId}`,
    diff: {
      modelo: respuesta.model,
      documentoNombre: lamina.documentoNombre,
      numeroPagina: lamina.numeroPagina,
      tokensEntrada: respuesta.usage.input_tokens,
      tokensSalida: respuesta.usage.output_tokens,
      tokensCacheLectura: respuesta.usage.cache_read_input_tokens ?? 0,
      tokensCacheEscritura: respuesta.usage.cache_creation_input_tokens ?? 0,
    },
  });

  if (respuesta.parsed_output === null) {
    throw new Error(
      `Claude no devolvió un rótulo que valide contra el contrato (lámina ${lamina.laminaId}, stop_reason: ${respuesta.stop_reason}).`,
    );
  }
  return sanearRotulo(respuesta.parsed_output);
}

function instruccion(lamina: LaminaInput, ctx?: ObraContexto): string {
  const partes = [
    `Documento: "${lamina.documentoNombre}", página ${lamina.numeroPagina}.`,
    // Todo el contexto de obra —tipo, resumen, índice de láminas, instrucciones
    // del estudio— lo arma `prompt.ts`, que es puro y sí tiene tests.
    ctx ? armarContextoObra(ctx) : null,
    'Leé el rótulo y extraé las entidades computables de esta lámina.',
    lamina.textoExtraido
      ? `\nTexto extraído del PDF (es literal, confiá en él por sobre lo que creas ver en el dibujo):\n---\n${lamina.textoExtraido}\n---`
      : null,
  ];
  return partes.filter((parte) => parte !== null).join('\n');
}

async function pedirAnalisis(
  cliente: Anthropic,
  lamina: LaminaInput,
  ctx?: ObraContexto,
): Promise<AnalisisLamina> {
  const respuesta = await cliente.messages.parse({
    model: modelo(),
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SISTEMA,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: Buffer.from(lamina.pdfBytes).toString('base64'),
            },
          },
          { type: 'text', text: instruccion(lamina, ctx) },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(zAnalisisLaminaCrudo) },
  });

  // El cable es laxo a propósito (ver tipos.ts): acá se aplica el contrato
  // estricto y se descartan las entidades irrecuperables, contándolas.
  const saneo =
    respuesta.parsed_output === null ? null : sanearAnalisis(respuesta.parsed_output);

  // RNF-7: el costo por obra se mide desde acá. `obraId` sale del contexto, que
  // ahora llega también desde `leerRotulo`; un llamador que no lo pase deja la
  // fila sin obra y el vínculo queda por `targetRef` (lámina → obra).
  await registrarAuditoria({
    obraId: ctx?.obraId,
    actorTipo: 'agente',
    actorNombre: 'analisis-claude',
    accion: 'analisis_llm',
    targetRef: `laminas:${lamina.laminaId}`,
    diff: {
      modelo: respuesta.model,
      documentoNombre: lamina.documentoNombre,
      numeroPagina: lamina.numeroPagina,
      tokensEntrada: respuesta.usage.input_tokens,
      tokensSalida: respuesta.usage.output_tokens,
      tokensCacheLectura: respuesta.usage.cache_read_input_tokens ?? 0,
      tokensCacheEscritura: respuesta.usage.cache_creation_input_tokens ?? 0,
      entidadesDescartadas: saneo?.entidadesDescartadas ?? 0,
    },
  });

  if (saneo === null) {
    throw new Error(
      `Claude no devolvió un análisis que valide contra el contrato (lámina ${lamina.laminaId}, stop_reason: ${respuesta.stop_reason}).`,
    );
  }
  return saneo.analisis;
}

export function crearProviderClaude(): AnalysisProvider {
  const cliente = new Anthropic();
  // Una lámina = una llamada. El pipeline pide primero el rótulo y después las
  // entidades; sin esto pagaríamos el PDF dos veces.
  //
  // Corolario: **la que manda es la primera llamada**. La segunda recibe la
  // promesa ya en curso, con el prompt que armó la primera. Por eso `leerRotulo`
  // también acepta el `ObraContexto` y lo pasa: si no, el contexto de obra no
  // llegaba nunca al prompt (deuda del HANDOFF §8).
  const analisisPorLamina = new Map<string, Promise<AnalisisLamina>>();

  function analizar(lamina: LaminaInput, ctx?: ObraContexto): Promise<AnalisisLamina> {
    const enCurso = analisisPorLamina.get(lamina.laminaId);
    if (enCurso) return enCurso;

    const promesa = pedirAnalisis(cliente, lamina, ctx).catch((error: unknown) => {
      // Un fallo no se cachea: reprocesar la lámina tiene que poder reintentar.
      analisisPorLamina.delete(lamina.laminaId);
      throw error;
    });
    analisisPorLamina.set(lamina.laminaId, promesa);
    if (analisisPorLamina.size > MAX_LAMINAS_EN_MEMORIA) {
      const masVieja = analisisPorLamina.keys().next().value;
      if (masVieja !== undefined) analisisPorLamina.delete(masVieja);
    }
    return promesa;
  }

  return {
    async leerRotulo(lamina, ctx) {
      return structuredClone((await analizar(lamina, ctx)).rotulo);
    },
    // A propósito fuera de `analizar()`: el inventario NO lee ni escribe el
    // caché por lámina. Si lo leyera, una lámina ya extraída devolvería el
    // rótulo caro y estaría bien; si lo escribiera, la extracción posterior
    // recibiría una promesa que nunca tuvo entidades — que es un bug, no un
    // ahorro.
    async inventariar(lamina, ctx) {
      return pedirInventario(cliente, lamina, ctx);
    },
    async extraerEntidades(lamina, ctx) {
      return structuredClone((await analizar(lamina, ctx)).entidades);
    },
  };
}
