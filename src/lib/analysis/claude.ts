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
2. Toda entidad necesita \`bbox\`: [x, y, ancho, alto] normalizado 0–1 sobre la lámina, con origen arriba a la izquierda. Si no podés ubicarla en el dibujo, no la devuelvas.
3. \`confianza\` es tu confianza real (0–1), no un número de cortesía.
4. \`escalaConfiable\` es \`true\` SOLO si verificaste la escala declarada contra al menos dos cotas leídas del plano, con 3 % de tolerancia. Si no pudiste verificarla, es \`false\` — la lámina queda bloqueada hasta que el usuario cargue una medida de referencia, y eso está bien.
5. Medidas en metros y metros cuadrados. Textos y nombres en español rioplatense (es-AR).
6. \`estadoReforma\`: usá \`na\` en obra nueva. En reforma o ampliación, \`existente\`, \`demoler\` o \`nueva\` según lo que la lámina indique explícitamente (rayado de demolición, referencias, etc.); si la lámina no lo dice, \`na\`.
7. Claves exactas de \`atributos\` según el tipo de entidad:
   - ambiente: superficieM2, perimetroM, alturaM, vanosM2
   - abertura: tag, tipologia ('ventana' | 'puerta' | 'paño fijo'), anchoM, altoM
   - tabique: tipo ('durlock'), largoM, alturaM, caras
   - muro: tipo ('mamposteria'), largoM, alturaM
   - terminacion: superficieM2, ubicacion ('piso' | 'cielorraso' | 'pared'), ambiente (nombre del ambiente)
   No inventes claves nuevas y no incluyas una clave cuyo valor no leíste.

Si la lámina no es un plano con entidades computables (una planilla, una carátula, una memoria), devolvé el rótulo que puedas leer y \`entidades: []\`.`;

function instruccion(lamina: LaminaInput, ctx?: ObraContexto): string {
  const partes = [
    `Documento: "${lamina.documentoNombre}", página ${lamina.numeroPagina}.`,
    ctx ? `Obra de tipo: ${ctx.tipoObra}.` : null,
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

  // RNF-7: el costo por obra se mide desde acá. Cuando la llamada la dispara
  // `leerRotulo` todavía no hay `ObraContexto`, así que el vínculo con la obra
  // queda por `targetRef` (lámina → obra).
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
    async leerRotulo(lamina) {
      return structuredClone((await analizar(lamina)).rotulo);
    },
    async extraerEntidades(lamina, ctx) {
      return structuredClone((await analizar(lamina, ctx)).entidades);
    },
  };
}
