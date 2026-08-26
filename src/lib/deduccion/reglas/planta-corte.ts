/**
 * Regla `planta_corte` (§11 PRD) — factor 0,9.
 *
 * La planta dice dónde está y cuánto mide en el piso; la altura la dice el
 * corte. Un ambiente, un tabique o un muro sin `alturaM` la toma de la entidad
 * del mismo tipo y nombre que aparece en una lámina `corte`.
 *
 * Si dos cortes no coinciden, la regla se calla: eso no es una altura a deducir
 * sino una contradicción de la documentación, y la levanta `continuidad` como
 * inconsistencia.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import type { CandidatoDeduccion, ContextoDeduccion, SalidaRegla } from '@/lib/deduccion/motor';
import { describirValor, leerCampo } from '@/lib/deduccion/motor';
import type { TipoEntidad } from '@/types/domain';

/** Lo que tiene altura y se computa por altura. Las aberturas van por planilla. */
const TIPOS: readonly TipoEntidad[] = ['ambiente', 'tabique', 'muro'];

const CAMPO = 'alturaM';

/** Misma entidad = mismo tipo y mismo nombre, sin que la caja cambie nada. */
export function claveNombre(entidad: EntidadPersistida): string {
  return entidad.nombre.trim().toLocaleLowerCase('es-AR');
}

export function deducirPlantaCorte(
  entidades: readonly EntidadPersistida[],
  ctx: ContextoDeduccion,
): SalidaRegla {
  const candidatos: CandidatoDeduccion[] = [];

  for (const destino of entidades) {
    if (!TIPOS.includes(destino.tipo)) continue;
    if (ctx.tipoLamina(destino) === 'corte') continue; // el corte es la fuente, no el destino
    if (leerCampo(destino, CAMPO) !== null) continue;
    const nombre = claveNombre(destino);
    if (nombre === '') continue;

    const enCortes = entidades.filter(
      (otra) =>
        otra.id !== destino.id &&
        otra.tipo === destino.tipo &&
        otra.laminaId !== destino.laminaId &&
        claveNombre(otra) === nombre &&
        ctx.tipoLamina(otra) === 'corte' &&
        leerCampo(otra, CAMPO) !== null,
    );
    if (enCortes.length === 0) continue;

    const valores = new Set(enCortes.map((corte) => leerCampo(corte, CAMPO)!));
    if (valores.size > 1) continue; // los cortes se contradicen: no hay deducción

    const fuente = enCortes[0]!;
    const valor = leerCampo(fuente, CAMPO)!;
    const dondeFalta =
      ctx.tipoLamina(destino) === 'planta'
        ? `en la planta (lámina ${ctx.codigoLamina(destino)})`
        : `en la lámina ${ctx.codigoLamina(destino)}`;

    candidatos.push({
      destino,
      campo: CAMPO,
      valor,
      aportes: [destino, ...enCortes],
      explicacion:
        `La altura ${describirValor(CAMPO, valor)} de ${destino.nombre.trim()} sale del corte ` +
        `(lámina ${ctx.codigoLamina(fuente)}); ${dondeFalta} no está acotada.`,
    });
  }

  return { candidatos, inconsistencias: [] };
}
