/**
 * Cruce real: Claude leyendo el expediente entero, ya compactado a texto.
 *
 * Espejado sobre `busqueda-claude.ts`: mismo cliente, mismo structured output
 * con cable laxo, misma auditoría de tokens (RNF-7, acción `cruce_llm`).
 *
 * La diferencia con las otras cuatro familias no es técnica sino de alcance: acá
 * no viaja un PDF sino la **memoria compactada** de toda la obra
 * (`src/lib/memoria/compacta.ts`), porque lo que se pregunta no se puede
 * contestar mirando una lámina. "¿La FP01 de la planta es la misma que la de la
 * planilla?" es una pregunta sobre dos láminas a la vez, y "¿cuál es la altura
 * de local?" es una pregunta sobre el corte que le sirve a la planta.
 *
 * **Este archivo no tiene tests automáticos** (los tests no usan red, por
 * global-constraints). Por eso es chico y todo lo testeable —el contrato, el
 * saneo, la resolución de códigos, el filtro de campos deducibles— vive en
 * `cruce-tipos.ts`, que sí los tiene.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { registrarAuditoria } from '@/lib/audit';
import { CAMPOS_DEDUCIBLES } from '@/lib/deduccion/motor';
import type { ObraContexto } from '@/types/domain';

import {
  cruceVacio,
  zRespuestaCruceCruda,
  type CruceProvider,
  type RespuestaCruceCruda,
} from './cruce-tipos';
import { armarContextoObra } from './prompt';

function modelo(): string {
  return process.env.ANALYSIS_MODEL ?? 'claude-sonnet-5';
}

/**
 * P4 en forma de prompt, del lado del cruce. La tentación de este caso de uso es
 * **completar el rompecabezas**: se le da al modelo el expediente entero y se le
 * pide que lo relacione, así que cualquier hueco parece una invitación a
 * rellenarlo con lo que "tiene sentido". No lo es. Un dato que ninguna lámina
 * escribe es un hueco que el arquitecto tiene que ver en la bandeja, no un
 * promedio de obra argentina.
 *
 * La otra regla que se gana acá es la de las citas: el modelo no conoce los
 * uuids de las láminas, así que todo se cita por el **código del rótulo**. Un
 * código inventado se descarta entero en `sanearCruce()`.
 */
const SISTEMA = `Sos un computista de obra que trabaja para un estudio de arquitectura argentino. Te paso la memoria del expediente completo —lo que la extracción leyó de TODAS las láminas, junto— y tu trabajo es cruzarla: encontrar lo que una lámina dice y a otra le falta, reconocer qué elementos son el mismo, y marcar lo que se contradice.

Reglas que no se negocian:

1. CRUZÁ SOLO LO QUE ESTÁ ESCRITO. Cada cosa que devolvés tiene que estar escrita en la memoria, en alguna lámina. No estimes, no promedies, no completes con medidas típicas ni con conocimiento general de construcción. Una altura de local que ninguna lámina declara no es 2,60: es un dato que falta, y el sistema ya sabe preguntárselo al proyectista.
2. CITÁ LA LÁMINA POR SU CÓDIGO, tal como figura en la memoria ("PL01", "DET00", "CO01"). Si no podés decir en qué lámina está escrito el dato, no lo devuelvas.
3. \`valor\` es el dato TAL COMO ESTÁ ESCRITO, sin unidades ni texto de más: "2,60", no "2,60 m" ni "altura 2,60". Medidas en metros: si la lámina está en centímetros, convertí a metros.
4. \`completados\` es para MEDIDAS de un elemento que están escritas en otra lámina. Los únicos campos válidos son: ${CAMPOS_DEDUCIBLES.join(', ')}. Nada estructural ni de seguridad —cargas, secciones, armaduras— se completa así, nunca. Y JAMÁS un precio: los precios no son tu trabajo.
5. \`datosObra\` es para hechos que valen para toda la obra o para un nivel: altura de local, nivel de piso terminado, altura de revestimiento. Usá claves con punto: \`altura_local.PB\`, \`nivel.PB\`, \`altura_revestimiento.general\`.
6. \`identidades\` agrupa elementos de láminas DISTINTAS que son el mismo elemento físico (la FP01 de la planta y la FP01 de la planilla). Un grupo de uno no es una identidad: no lo devuelvas.
7. \`conflictos\` es para dos datos escritos que no pueden ser los dos ciertos. Decí cuál dice cada lámina y, si se te ocurre, por qué podrían diferir (vano de albañilería contra hoja, revisión vieja contra nueva). No elijas cuál gana: eso lo decide el arquitecto.
8. \`relecturas\` es para pedir volver a mirar una lámina puntual con una pregunta concreta, cuando la memoria sugiere que el dato está ahí pero no llegó a la extracción.
9. \`confianza\` es tu confianza real (0–1), no un número de cortesía. Si el cruce depende de que dos nombres parecidos sean el mismo elemento, bajala.
10. Si no encontrás nada en alguna categoría, devolvé la lista vacía. Es una respuesta correcta y esperada: un expediente prolijo puede no tener ningún conflicto.`;

function instruccion(memoria: string, ctx: ObraContexto): string {
  const partes = [
    armarContextoObra(ctx),
    ctx.nombreObra !== undefined && ctx.nombreObra.trim() !== ''
      ? `Obra: "${ctx.nombreObra}".`
      : null,
    '',
    'Memoria del expediente (es lo que la extracción leyó de todas las láminas):',
    '---',
    memoria,
    '---',
    '',
    'Cruzá esta memoria y devolvé lo que encuentres en las cinco categorías.',
  ];
  return partes.filter((parte) => parte !== null).join('\n');
}

export function crearProviderCruceClaude(): CruceProvider {
  const cliente = new Anthropic();

  return {
    nombre: 'cruce-claude',

    async cruzar(memoria: string, ctx: ObraContexto): Promise<RespuestaCruceCruda> {
      // Sin memoria no hay expediente que cruzar: pagar la llamada más cara del
      // sistema para mandar una hoja en blanco sería quemarle créditos al
      // usuario.
      if (memoria.trim() === '') return cruceVacio();

      const respuesta = await cliente.messages.parse({
        model: modelo(),
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: SISTEMA,
        messages: [{ role: 'user', content: instruccion(memoria, ctx) }],
        output_config: { format: zodOutputFormat(zRespuestaCruceCruda) },
      });

      const cruce = respuesta.parsed_output ?? cruceVacio();

      // RNF-7: el costo por obra se mide desde acá. El cruce es la llamada más
      // grande del pipeline —el expediente entero en un solo prompt—, así que su
      // renglón en `auditoria` es el que más pesa en "¿cuánto me costó esta obra
      // y en qué?". Los conteos son de lo que **volvió**: los descartes los
      // cuenta `sanearCruce()`, que corre en el pipeline porque necesita el mapa
      // de láminas y entidades de la obra.
      await registrarAuditoria({
        obraId: ctx.obraId,
        actorTipo: 'agente',
        actorNombre: 'cruce-claude',
        accion: 'cruce_llm',
        targetRef: `obras:${ctx.obraId}`,
        diff: {
          modelo: respuesta.model,
          tokensEntrada: respuesta.usage.input_tokens,
          tokensSalida: respuesta.usage.output_tokens,
          tokensCacheLectura: respuesta.usage.cache_read_input_tokens ?? 0,
          tokensCacheEscritura: respuesta.usage.cache_creation_input_tokens ?? 0,
          caracteresMemoria: memoria.length,
          datosObra: cruce.datosObra.length,
          completados: cruce.completados.length,
          identidades: cruce.identidades.length,
          conflictos: cruce.conflictos.length,
          relecturas: cruce.relecturas.length,
        },
      });

      return cruce;
    },
  };
}
