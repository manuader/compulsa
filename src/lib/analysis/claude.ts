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
import type { LaminaInput, ObraContexto } from '@/types/domain';
import { armarContextoObra } from './prompt';
import {
  sanearAnalisis,
  zAnalisisLaminaCrudo,
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
4. \`escalaConfiable\` es \`true\` SOLO si verificaste la escala declarada contra al menos dos cotas leídas del plano, con 3 % de tolerancia. Si no pudiste verificarla, es \`false\` — la lámina queda bloqueada hasta que el usuario cargue una medida de referencia, y eso está bien.
5. Medidas en metros y metros cuadrados. Textos y nombres en español rioplatense (es-AR).
6. \`estadoReforma\`: usá \`na\` en obra nueva. En reforma o ampliación, \`existente\`, \`demoler\` o \`nueva\` según lo que la lámina indique explícitamente (rayado de demolición, referencias, etc.); si la lámina no lo dice, \`na\`.
7. Claves exactas de \`atributos\` según el tipo de entidad:
   - ambiente: superficieM2, perimetroM, alturaM, vanosM2
   - abertura: tag, tipologia ('ventana' | 'puerta' | 'paño fijo'), anchoM, altoM, material, vidrio, cantidad — \`material\` y \`vidrio\` son texto libre tal como los escribe la lámina ("aluminio línea Módena", "DVH 4/9/4"). \`cantidad\` es SOLO de las filas de una planilla de carpinterías, donde la tabla dice cuántas hay de esa tipología: una abertura dibujada en una planta es una, y ahí la clave no va.
   - tabique: tipo ('durlock'), largoM, alturaM, caras
   - muro: tipo ('mamposteria'), largoM, alturaM
   - terminacion: superficieM2, ubicacion ('piso' | 'cielorraso' | 'pared'), ambiente (nombre del ambiente)
   No inventes claves nuevas y no incluyas una clave cuyo valor no leíste.
8. Cuando la lámina no es un plano con entidades dibujadas, fijate bien qué es antes de darla por vacía:
   - **Planilla de carpinterías** (la tabla de aberturas del proyecto: una fila por tipología, con sus medidas): extraé **una entidad \`abertura\` por fila de la tabla**, con \`bbox\` = la fila. Es la lámina donde el estudio escribe las medidas que en la planta no están: saltearla es perder el dato. De cada fila devolvé **solo las claves que esa fila trae escritas** (\`tag\`, \`tipologia\`, \`anchoM\`, \`altoM\`, \`material\`, \`vidrio\`, \`cantidad\`); la clave que no está escrita no va (regla 1). \`cantidad\` es informativa y **no computa**: cuántas se compran lo dice la planta, no la planilla.
   - **Carátula, memoria descriptiva, índice de láminas o cualquier otra lámina sin nada computable**: devolvé el rótulo que puedas leer y \`entidades: []\`.`;

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
    async extraerEntidades(lamina, ctx) {
      return structuredClone((await analizar(lamina, ctx)).entidades);
    },
  };
}
