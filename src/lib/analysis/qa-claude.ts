/**
 * Q&A real: Claude leyendo el texto del expediente (RF-106).
 *
 * Espejado sobre `presupuesto-claude.ts` y `claude.ts`: mismo cliente, mismo
 * structured output con cable laxo + saneo, misma auditoría de tokens (RNF-7,
 * acción `qa_llm`).
 *
 * Acá **no viajan PDFs**: viaja el texto que el pipeline ya extrajo de cada
 * lámina (`laminas.texto_extraido`) más su rótulo. Es lo que hace que preguntarle
 * al expediente cueste lo que cuesta leer un legajo y no lo que cuesta volver a
 * mirar cincuenta planos, y es también lo que garantiza que la respuesta se pueda
 * citar: cada bloque de texto entra numerado con su código de lámina, y el modelo
 * cita ese código.
 *
 * **Este archivo no tiene tests automáticos** (los tests no usan red, por
 * global-constraints). Por eso es chico y todo lo testeable —el contrato, el
 * saneo, la resolución de citas— vive en `qa-tipos.ts`, que sí los tiene.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { registrarAuditoria } from '@/lib/audit';

import {
  etiquetaLamina,
  respuestaVacia,
  sanearRespuestaQa,
  zRespuestaQaCruda,
  type ContextoQa,
  type LaminaQa,
  type QaProvider,
  type RespuestaQa,
} from './qa-tipos';

function modelo(): string {
  return process.env.ANALYSIS_MODEL ?? 'claude-sonnet-5';
}

/**
 * P4 (deducir, no inventar) en forma de prompt, del lado del Q&A. La tentación
 * de este caso de uso es contestar con conocimiento general de construcción
 * ("una ventana estándar mide…"): eso sería exactamente lo que el producto no
 * puede hacer. Si el expediente no lo dice, la respuesta es que no lo dice.
 */
const SISTEMA = `Sos el asistente de un estudio de arquitectura argentino. Contestás preguntas sobre el expediente de una obra usando ÚNICAMENTE el texto de las láminas que te paso.

Reglas que no se negocian:

1. NO INVENTES. Si el texto de las láminas no contesta la pregunta, respondé exactamente "No encontré eso en el expediente." y devolvé \`citas: []\`. No completes con conocimiento general de construcción, no supongas medidas típicas, no infieras lo que "seguramente" quiso decir el proyectista.
2. TODA respuesta lleva al menos una cita. En \`citas\` va el CÓDIGO de cada lámina en la que está el dato (por ejemplo "A-01"), tal como te lo paso en el encabezado de cada bloque. No inventes códigos ni cites una lámina que no aparece en la lista.
3. Citá solo las láminas que efectivamente sostienen la respuesta, no todas las que leíste.
4. Respondé en castellano rioplatense (es-AR, voseo), en dos o tres oraciones como mucho, con los números tal como figuran en la lámina.
5. Si el expediente dice dos cosas distintas sobre lo mismo, decilo: contá las dos versiones y citá las dos láminas. No elijas una por tu cuenta.
6. Si la pregunta es sobre algo estructural o de seguridad, respondé lo que dice la documentación y aclará que cualquier definición la tiene que tomar un profesional competente.`;

/** Un bloque por lámina, encabezado con el código que el modelo tiene que citar. */
function bloqueDeLamina(lamina: LaminaQa): string | null {
  const texto = lamina.textoExtraido?.trim();
  if (texto === undefined || texto === '') return null;

  const partes = [
    `[${etiquetaLamina(lamina)}]`,
    lamina.titulo !== null ? ` ${lamina.titulo}` : '',
    lamina.tipo !== null ? ` (${lamina.tipo})` : '',
  ];
  return `${partes.join('')}\n${texto}`;
}

function instruccion(pregunta: string, contexto: ContextoQa): string {
  const bloques = contexto.laminas
    .map(bloqueDeLamina)
    .filter((bloque): bloque is string => bloque !== null);

  return [
    `Obra: "${contexto.obraNombre}".`,
    `Pregunta del arquitecto: ${pregunta}`,
    '',
    'Texto de las láminas del expediente (es literal, es todo lo que hay):',
    '---',
    bloques.join('\n\n'),
    '---',
  ].join('\n');
}

export function crearProviderQaClaude(): QaProvider {
  const cliente = new Anthropic();

  return {
    async responder(pregunta: string, contexto: ContextoQa): Promise<RespuestaQa> {
      const limpia = pregunta.trim();
      if (limpia === '') return respuestaVacia();

      // Sin texto extraído no hay expediente que leer: preguntarle al modelo
      // sería pagar una llamada para que conteste de memoria (y eso es P4).
      const conTexto = contexto.laminas.filter(
        (lamina) => lamina.textoExtraido !== null && lamina.textoExtraido.trim() !== '',
      );
      if (conTexto.length === 0) return respuestaVacia();

      /** El expediente **tal como lo vio el modelo**: lo que va al prompt y lo
       *  único contra lo que después se pueden resolver las citas. */
      const visto: ContextoQa = { ...contexto, laminas: conTexto };

      const respuesta = await cliente.messages.parse({
        model: modelo(),
        // 16 000 como los otros dos providers, aunque la respuesta sean tres
        // oraciones: el thinking adaptativo consume del mismo techo, y quedarse
        // corto trunca la respuesta a mitad de una cita.
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: SISTEMA,
        messages: [{ role: 'user', content: instruccion(limpia, visto) }],
        output_config: { format: zodOutputFormat(zRespuestaQaCruda) },
      });

      // El cable es laxo a propósito (ver `qa-tipos.ts`): acá se resuelven las
      // citas contra el expediente real y se descarta lo que no existe.
      //
      // El saneo va contra `visto`, **las mismas láminas que vio el prompt**, y
      // no contra el `contexto` sin filtrar: si no, una lámina sin texto
      // extraído —que el modelo nunca leyó— seguía siendo citable, y una cita
      // adivinada de memoria sobre un plano que no se le mandó pasaba el filtro
      // como si fuera una lectura (P4: deducir no es inventar).
      const saneo =
        respuesta.parsed_output === null
          ? { respuesta: respuestaVacia(), citasDescartadas: 0 }
          : sanearRespuestaQa(respuesta.parsed_output, visto);

      // RNF-7: el costo por obra se mide desde acá.
      await registrarAuditoria({
        obraId: contexto.obraId,
        actorTipo: 'agente',
        actorNombre: 'qa-claude',
        accion: 'qa_llm',
        targetRef: `obras:${contexto.obraId}`,
        diff: {
          modelo: respuesta.model,
          pregunta: limpia,
          laminasConTexto: conTexto.length,
          tokensEntrada: respuesta.usage.input_tokens,
          tokensSalida: respuesta.usage.output_tokens,
          tokensCacheLectura: respuesta.usage.cache_read_input_tokens ?? 0,
          tokensCacheEscritura: respuesta.usage.cache_creation_input_tokens ?? 0,
          citas: saneo.respuesta.citas.length,
          citasDescartadas: saneo.citasDescartadas,
        },
      });

      return saneo.respuesta;
    },
  };
}
