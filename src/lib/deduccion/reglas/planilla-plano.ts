/**
 * Regla `planilla_plano` (§11 PRD) — factor 0,95, la más confiable de las cinco.
 *
 * La misma carpintería está dibujada dos veces en el expediente: una en el plano
 * (planta, vista, corte) y otra en la planilla de carpinterías. Cuando una de
 * las dos la acota y la otra no, la que no la acota toma las medidas de su par
 * con el **mismo tag**.
 *
 * Va en los dos sentidos a propósito: planilla → plano completa lo que la planta
 * no dice, y plano → planilla es lo que permite reconstruir la planilla derivada
 * (RF-504) cuando el expediente directamente no la trae.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { normalizarTag } from '@/lib/computo/tags';
import type { CandidatoDeduccion, ContextoDeduccion, SalidaRegla } from '@/lib/deduccion/motor';
import { describirValor, etiquetaCampo, leerCampo } from '@/lib/deduccion/motor';
import { leerTexto } from '@/lib/hallazgos/taxonomia';

/** Solo las dos medidas de la carpintería: nada más se cruza entre plano y planilla. */
const CAMPOS = ['anchoM', 'altoM'] as const;

/**
 * Cómo se comparan dos tags. La definición vive en `@/lib/computo/tags` —una
 * hoja sin imports— porque `rubros/aberturas.ts` también la necesita y traerla
 * desde acá le metía el motor de deducción en el grafo (ver el comentario de
 * ese archivo). Se re-exporta para quien la busque en la regla que la motivó.
 */
export { normalizarTag };

/**
 * El tag de la abertura ("V2", "P1"). El atributo manda; si el análisis no lo
 * separó del nombre, el nombre sirve —en los planos el tag ES el nombre—.
 */
export function tagDeAbertura(entidad: EntidadPersistida): string | null {
  const tag = leerTexto(entidad, 'tag');
  if (tag !== null) return tag;
  const nombre = entidad.nombre.trim();
  return nombre === '' ? null : nombre;
}

export function deducirPlanillaPlano(
  entidades: readonly EntidadPersistida[],
  ctx: ContextoDeduccion,
): SalidaRegla {
  const aberturas = entidades.filter((entidad) => entidad.tipo === 'abertura');
  const candidatos: CandidatoDeduccion[] = [];

  for (const destino of aberturas) {
    const tag = tagDeAbertura(destino);
    if (tag === null) continue;
    const tagNormalizado = normalizarTag(tag);
    const destinoEnPlanilla = ctx.tipoLamina(destino) === 'planilla';

    for (const campo of CAMPOS) {
      if (leerCampo(destino, campo) !== null) continue;

      const fuente = aberturas.find((otra) => {
        const tagOtra = tagDeAbertura(otra);
        return (
          otra.id !== destino.id &&
          otra.laminaId !== destino.laminaId &&
          tagOtra !== null &&
          normalizarTag(tagOtra) === tagNormalizado &&
          // Exactamente una de las dos tiene que ser la planilla: entre dos
          // plantas no hay "planilla ↔ plano", hay continuidad.
          (ctx.tipoLamina(otra) === 'planilla') !== destinoEnPlanilla &&
          leerCampo(otra, campo) !== null
        );
      });
      if (fuente === undefined) continue;

      const valor = leerCampo(fuente, campo)!;
      candidatos.push({
        destino,
        campo,
        valor,
        aportes: [destino, fuente],
        explicacion: explicar({
          tag,
          campo,
          valor,
          destinoEnPlanilla,
          codigoDestino: ctx.codigoLamina(destino),
          codigoFuente: ctx.codigoLamina(fuente),
        }),
      });
    }
  }

  return { candidatos, inconsistencias: [] };
}

interface EntradaFrase {
  tag: string;
  campo: string;
  valor: number;
  destinoEnPlanilla: boolean;
  codigoDestino: string;
  codigoFuente: string;
}

function explicar(e: EntradaFrase): string {
  const dato = `El ${etiquetaCampo(e.campo)} ${describirValor(e.campo, e.valor)} de ${e.tag}`;
  return e.destinoEnPlanilla
    ? `${dato} lo trae el plano (lámina ${e.codigoFuente}); ` +
        `la planilla de carpinterías (lámina ${e.codigoDestino}) lo tiene vacío.`
    : `${dato} sale de la planilla de carpinterías (lámina ${e.codigoFuente}); ` +
        `en el plano (lámina ${e.codigoDestino}) la abertura está sin acotar.`;
}
