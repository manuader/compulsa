/**
 * Búsqueda dirigida real: Claude releyendo una lámina con una lista de pedidos.
 *
 * Espejado sobre `claude.ts` y `qa-claude.ts`: mismo cliente, mismo structured
 * output con cable laxo + saneo, misma auditoría de tokens (RNF-7, acción
 * `busqueda_llm`).
 *
 * La diferencia con `extraerEntidades` no es técnica sino de prompt: allá se
 * pide "contame todo lo que ves", acá se pide **exactamente** una lista de
 * datos. Es el prompt manual que el arquitecto escribe hoy a mano ("buscame el
 * ancho y el alto de FP01 en la planilla DET00"), sistematizado — y por eso la
 * lámina viaja entera, PDF y texto extraído: el dato puede estar en una celda
 * que el texto extraído desordena y que solo se entiende mirando la tabla.
 *
 * **Este archivo no tiene tests automáticos** (los tests no usan red, por
 * global-constraints). Por eso es chico y todo lo testeable —el contrato, el
 * saneo, el filtro por objetivos— vive en `busqueda-tipos.ts`, que sí los tiene.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { registrarAuditoria } from '@/lib/audit';
import type { LaminaInput, ObraContexto } from '@/types/domain';

import {
  esCampoDeMedida,
  sanearBusqueda,
  zRespuestaBusquedaCruda,
  type BusquedaProvider,
  type DatoEncontrado,
  type ObjetivoBusqueda,
} from './busqueda-tipos';
import { armarContextoObra } from './prompt';

function modelo(): string {
  return process.env.ANALYSIS_MODEL ?? 'claude-sonnet-5';
}

/**
 * P4 en forma de prompt, del lado de la búsqueda. La tentación de este caso de
 * uso es completar: se le dice al modelo qué le falta al sistema, y "una puerta
 * de 0,90 × 2,05" es la medida más común de la Argentina. Si la planilla no la
 * dice, la respuesta es que no la dice.
 */
const SISTEMA = `Sos un asistente que busca datos puntuales en una lámina de un proyecto de arquitectura argentino. Te doy una lista de datos que el cómputo necesita y vos me decís cuáles de esos datos están escritos en ESTA lámina.

Reglas que no se negocian:

1. NO ESTIMES NADA. Si el dato no está escrito en esta lámina, no lo devuelvas. No completes con medidas típicas, no infieras el alto a partir del ancho, no uses conocimiento general de construcción. Un dato que no está es un dato que no está: el sistema ya sabe preguntárselo al proyectista.
2. DEVOLVÉ SOLO LO QUE TE PIDO. Cada dato que devuelvas tiene que llevar una \`clave\` y un \`campo\` que estén en la lista de pedidos, escritos igual. Todo lo demás se descarta, aunque sea correcto: esta lámina se está leyendo para responder consultas concretas, no para inventariarla.
3. TODO dato lleva \`bbox\`: [x, y, ancho, alto] normalizado 0–1 sobre la lámina, con origen arriba a la izquierda, señalando dónde está escrito. Si no podés ubicarlo en la lámina, no lo devuelvas.
4. \`valor\` es el dato TAL COMO ESTÁ ESCRITO, sin unidades ni texto de más: "0,90", no "0,90 m" ni "ancho 0,90". Medidas en metros: si la planilla está en centímetros, convertí a metros.
5. \`confianza\` es tu confianza real (0–1), no un número de cortesía. Si la fila es ambigua o el número se lee con dificultad, bajala.
6. Si no encontrás ninguno de los datos pedidos, devolvé \`datos: []\`. Es una respuesta correcta y esperada: la mayoría de las láminas no tienen lo que se busca.`;

/** Un pedido, escrito para que el modelo pueda copiar `clave` y `campo`. */
function bloqueDeObjetivo(objetivo: ObjetivoBusqueda): string {
  const campos = objetivo.campos
    .map((campo) => `${campo} (${esCampoDeMedida(campo) ? 'número' : 'texto'})`)
    .join(', ');
  return [
    `- clave: ${objetivo.clave}`,
    `  qué falta: ${objetivo.descripcion}`,
    `  campos: ${campos}`,
  ].join('\n');
}

function instruccion(
  lamina: LaminaInput,
  objetivos: readonly ObjetivoBusqueda[],
  ctx: ObraContexto,
): string {
  const partes = [
    armarContextoObra(ctx),
    `Lámina: documento "${lamina.documentoNombre}", página ${lamina.numeroPagina}.`,
    '',
    'Datos que el cómputo necesita. Buscá EXCLUSIVAMENTE estos, en esta lámina:',
    objetivos.map(bloqueDeObjetivo).join('\n'),
    lamina.textoExtraido
      ? `\nTexto extraído del PDF (es literal, confiá en él por sobre lo que creas ver en el dibujo):\n---\n${lamina.textoExtraido}\n---`
      : null,
  ];
  return partes.filter((parte) => parte !== null).join('\n');
}

export function crearProviderBusquedaClaude(): BusquedaProvider {
  const cliente = new Anthropic();

  return {
    async buscarDatos(
      lamina: LaminaInput,
      objetivos: readonly ObjetivoBusqueda[],
      ctx: ObraContexto,
    ): Promise<DatoEncontrado[]> {
      // Sin pedidos no hay búsqueda: pagar una llamada para no preguntar nada
      // sería quemarle créditos al usuario.
      if (objetivos.length === 0) return [];

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
              { type: 'text', text: instruccion(lamina, objetivos, ctx) },
            ],
          },
        ],
        output_config: { format: zodOutputFormat(zRespuestaBusquedaCruda) },
      });

      // El cable es laxo a propósito (ver `busqueda-tipos.ts`): acá se aplica el
      // contrato y se descarta lo que no se pidió, lo que no se puede ubicar en
      // la lámina y lo que no es un número donde tiene que haber una medida.
      const saneo =
        respuesta.parsed_output === null
          ? { datos: [], descartados: 0 }
          : sanearBusqueda(respuesta.parsed_output.datos, objetivos);

      // RNF-7: el costo por obra se mide desde acá. La búsqueda dirigida es la
      // única familia de llamadas que el sistema dispara sola al terminar de
      // procesar un documento, así que su renglón en `auditoria` es lo que
      // permite contestar "¿cuánto me costó esta obra y en qué?".
      await registrarAuditoria({
        obraId: ctx.obraId,
        actorTipo: 'agente',
        actorNombre: 'busqueda-claude',
        accion: 'busqueda_llm',
        targetRef: `laminas:${lamina.laminaId}`,
        diff: {
          modelo: respuesta.model,
          documentoNombre: lamina.documentoNombre,
          numeroPagina: lamina.numeroPagina,
          tokensEntrada: respuesta.usage.input_tokens,
          tokensSalida: respuesta.usage.output_tokens,
          tokensCacheLectura: respuesta.usage.cache_read_input_tokens ?? 0,
          tokensCacheEscritura: respuesta.usage.cache_creation_input_tokens ?? 0,
          objetivos: objetivos.map((objetivo) => objetivo.clave),
          encontrados: saneo.datos.length,
          descartados: saneo.descartados,
        },
      });

      return saneo.datos;
    },
  };
}
