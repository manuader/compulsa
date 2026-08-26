/**
 * Parser de presupuestos real: Claude leyendo el PDF o el texto que mandó el
 * proveedor.
 *
 * Espejado sobre `claude.ts` (el de las láminas) a propósito: mismo cliente,
 * mismo structured output con cable laxo + saneo, misma auditoría de tokens
 * (RNF-7). Si mañana cambia la forma de llamar a la API, los dos archivos
 * cambian igual.
 *
 * El PDF viaja como documento nativo cuando hay bytes; si además hay texto
 * pegado por el usuario, va como referencia literal. No se rasteriza nada (el
 * proyecto no tiene canvas, ver `src/lib/pdf/texto.ts`).
 *
 * **Este archivo no tiene tests automáticos** (los tests no usan red, por
 * global-constraints). Por eso es chico y todo lo que se puede probar sin red
 * —el contrato, el saneo— vive en `presupuesto-tipos.ts`, que sí los tiene.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { registrarAuditoria } from '@/lib/audit';

import {
  sanearPresupuesto,
  zPresupuestoCrudo,
  type EntradaPresupuesto,
  type PresupuestoParseado,
  type PresupuestoProvider,
} from './presupuesto-tipos';

function modelo(): string {
  return process.env.ANALYSIS_MODEL ?? 'claude-sonnet-5';
}

/**
 * P4 (deducir, no inventar) en forma de prompt, del lado del presupuesto: el
 * modelo transcribe, no completa. Un precio inventado no es un error de
 * formato: es una comparativa mentirosa y una orden de compra mal emitida.
 */
const SISTEMA = `Sos un asistente de un estudio de arquitectura argentino que lee presupuestos de proveedores (corralones, carpinterías, contratistas) y los transcribe a datos estructurados para compararlos.

Reglas que no se negocian:

1. NO INVENTES PRECIOS. Transcribís lo que está escrito. Un campo que el presupuesto no declara va \`null\` y se acabó: no estimes un unitario, no completes una cantidad "razonable" y no calcules el total si el proveedor no lo puso.
2. Una línea por ítem cotizado, en el orden del presupuesto. Los renglones de subtotal, descuento, IVA y total NO son líneas: el total va en \`metadatos.total\`.
3. Números en formato decimal (punto), sin separador de miles y sin símbolo: "1.234.567,89" se transcribe como 1234567.89. Los importes son los del presupuesto, no los recalcules.
4. \`precioUnitario\` y \`precioTotal\`: si el presupuesto trae los dos, van los dos; si trae uno solo, ese va donde corresponde y el otro queda \`null\`. Jamás dividas ni multipliques para completar el que falta.
5. \`unidad\`: la del proveedor tal como la escribió (u, m2, ml, kg, l…). Si no la declaró, \`null\`.
6. \`claveItemSugerida\`: SOLO si el proveedor citó el código del ítem del pedido (por ejemplo "seco.placas" o "V2"). Si no lo citó, \`null\` — no lo adivines por la descripción.
7. \`notas\`: aclaraciones de esa línea que cambian lo que se está cotizando (marca alternativa, "sin colocación", "sujeto a stock"). Si no hay, \`null\`.
8. \`metadatos.incluyeIva\`: \`true\` solo si el presupuesto dice que el precio lleva el IVA adentro; \`false\` si dice que va aparte, discriminado o "más IVA"; \`null\` si no lo menciona.
9. \`validezDias\` y \`plazoDias\` en días corridos, enteros. Si el presupuesto los da en otra unidad ("2 semanas"), convertilos; si no los declara, \`null\`.
10. Textos en español rioplatense, tal como los escribió el proveedor.`;

function instruccion(entrada: EntradaPresupuesto): string {
  const partes = [
    `Presupuesto: "${entrada.nombre}".`,
    'Transcribí las líneas cotizadas y las condiciones del presupuesto.',
    entrada.texto
      ? `\nTexto del presupuesto (es literal, confiá en él):\n---\n${entrada.texto}\n---`
      : null,
  ];
  return partes.filter((parte) => parte !== null).join('\n');
}

function contenido(entrada: EntradaPresupuesto): Anthropic.ContentBlockParam[] {
  const bloques: Anthropic.ContentBlockParam[] = [];
  if (entrada.pdfBytes !== undefined) {
    bloques.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from(entrada.pdfBytes).toString('base64'),
      },
    });
  }
  bloques.push({ type: 'text', text: instruccion(entrada) });
  return bloques;
}

export function crearProviderPresupuestoClaude(): PresupuestoProvider {
  const cliente = new Anthropic();

  return {
    async parsear(entrada: EntradaPresupuesto): Promise<PresupuestoParseado> {
      if (entrada.texto === undefined && entrada.pdfBytes === undefined) {
        throw new RangeError(
          `No hay nada que leer del presupuesto "${entrada.nombre}": mandá el texto o el PDF.`,
        );
      }

      const respuesta = await cliente.messages.parse({
        model: modelo(),
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: SISTEMA,
        messages: [{ role: 'user', content: contenido(entrada) }],
        output_config: { format: zodOutputFormat(zPresupuestoCrudo) },
      });

      // El cable es laxo a propósito (ver `presupuesto-tipos.ts`): acá se aplica
      // el contrato estricto y se descartan las líneas irrecuperables.
      const saneo =
        respuesta.parsed_output === null ? null : sanearPresupuesto(respuesta.parsed_output);

      // RNF-7: el costo por obra se mide desde acá. El presupuesto todavía no
      // es una cotización persistida, así que el vínculo es por nombre.
      await registrarAuditoria({
        actorTipo: 'agente',
        actorNombre: 'presupuesto-claude',
        accion: 'presupuesto_llm',
        targetRef: `presupuestos:${entrada.nombre}`,
        diff: {
          modelo: respuesta.model,
          tokensEntrada: respuesta.usage.input_tokens,
          tokensSalida: respuesta.usage.output_tokens,
          tokensCacheLectura: respuesta.usage.cache_read_input_tokens ?? 0,
          tokensCacheEscritura: respuesta.usage.cache_creation_input_tokens ?? 0,
          lineas: saneo?.presupuesto.lineas.length ?? 0,
          lineasDescartadas: saneo?.lineasDescartadas ?? 0,
        },
      });

      if (saneo === null) {
        throw new Error(
          `Claude no devolvió un presupuesto que valide contra el contrato ("${entrada.nombre}", stop_reason: ${respuesta.stop_reason}).`,
        );
      }
      return saneo.presupuesto;
    },
  };
}
