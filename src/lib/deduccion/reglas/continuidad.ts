/**
 * Regla `continuidad` (§11 PRD) — factor 0,85.
 *
 * El mismo elemento aparece en varias láminas: una montante que se ve en PB y en
 * azotea atraviesa PA aunque PA no la dibuje. Lo que una lámina acota completa lo
 * que la otra calla.
 *
 * La condición dura es que el valor sea **único** entre las láminas. Si dos
 * láminas dicen cosas distintas, la documentación se contradice: no hay
 * deducción posible y sale un hallazgo `inconsistencia` no bloqueante para que
 * el arquitecto decida cuál dato vale (§11, clase 2).
 *
 * Las cotas quedan afuera: su identidad no es el nombre sino el par
 * `sobre`/`tramo`, y de ellas se ocupa `cierre_cotas`.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { fuentesDeEntidades } from '@/lib/computo/presentacion';
import type { CandidatoDeduccion, ContextoDeduccion, SalidaRegla } from '@/lib/deduccion/motor';
import { CAMPOS_DEDUCIBLES, describirValor, enumerar, etiquetaCampo, leerCampo } from '@/lib/deduccion/motor';
import { claveNombre } from '@/lib/deduccion/reglas/planta-corte';
import { hallazgoInconsistencia } from '@/lib/hallazgos/taxonomia';
import type { HallazgoDetectado } from '@/types/domain';

export function deducirContinuidad(
  entidades: readonly EntidadPersistida[],
  ctx: ContextoDeduccion,
): SalidaRegla {
  const candidatos: CandidatoDeduccion[] = [];
  const inconsistencias: HallazgoDetectado[] = [];

  for (const grupo of agruparPorElemento(entidades)) {
    // Continuidad es, por definición, entre láminas: dos dibujos del mismo
    // elemento en la misma lámina no se completan entre sí.
    const laminas = new Set(grupo.map((entidad) => entidad.laminaId));
    if (laminas.size < 2) continue;

    const nombre = grupo[0]!.nombre.trim();

    for (const campo of CAMPOS_DEDUCIBLES) {
      const portadores = grupo.filter((entidad) => leerCampo(entidad, campo) !== null);
      if (portadores.length === 0) continue;

      const valores = new Set(portadores.map((entidad) => leerCampo(entidad, campo)!));
      if (valores.size > 1) {
        inconsistencias.push(contradiccion({ nombre, campo, portadores, ctx }));
        continue;
      }

      const valor = leerCampo(portadores[0]!, campo)!;

      for (const destino of grupo) {
        if (leerCampo(destino, campo) !== null) continue;
        const otros = portadores.filter((entidad) => entidad.laminaId !== destino.laminaId);
        if (otros.length === 0) continue;

        candidatos.push({
          destino,
          campo,
          valor,
          aportes: [destino, ...otros],
          explicacion: explicar({ nombre, campo, valor, destino, otros, ctx }),
        });
      }
    }
  }

  return { candidatos, inconsistencias };
}

/**
 * Agrupa por "mismo elemento": tipo + nombre. El tipo importa —un ambiente
 * "Estar" y un muro "Estar" no son el mismo elemento— y el orden de los grupos
 * es el de aparición, para que la salida del motor sea determinística.
 */
function agruparPorElemento(entidades: readonly EntidadPersistida[]): EntidadPersistida[][] {
  const grupos = new Map<string, EntidadPersistida[]>();
  for (const entidad of entidades) {
    if (entidad.tipo === 'cota') continue;
    const nombre = claveNombre(entidad);
    if (nombre === '') continue;
    const clave = `${entidad.tipo} ${nombre}`;
    const grupo = grupos.get(clave);
    if (grupo) grupo.push(entidad);
    else grupos.set(clave, [entidad]);
  }
  return [...grupos.values()];
}

interface EntradaFrase {
  nombre: string;
  campo: string;
  valor: number;
  destino: EntidadPersistida;
  otros: readonly EntidadPersistida[];
  ctx: ContextoDeduccion;
}

function explicar(e: EntradaFrase): string {
  const codigos = [...new Set(e.otros.map((entidad) => e.ctx.codigoLamina(entidad)))];
  const donde =
    codigos.length === 1 ? `en la lámina ${codigos[0]}` : `en las láminas ${enumerar(codigos)}`;
  return (
    `${e.nombre} no tiene ${etiquetaCampo(e.campo)} en la lámina ${e.ctx.codigoLamina(e.destino)}, ` +
    `pero aparece ${donde} con ${describirValor(e.campo, e.valor)}: por continuidad es el mismo elemento.`
  );
}

interface EntradaContradiccion {
  nombre: string;
  campo: string;
  portadores: readonly EntidadPersistida[];
  ctx: ContextoDeduccion;
}

function contradiccion(e: EntradaContradiccion): HallazgoDetectado {
  const lecturas = e.portadores.map(
    (entidad) =>
      `${describirValor(e.campo, leerCampo(entidad, e.campo)!)} (lámina ${e.ctx.codigoLamina(entidad)})`,
  );
  return hallazgoInconsistencia({
    rubro: null, // es coherencia de la documentación, no de un rubro
    clave: `deduccion.continuidad.${e.nombre}.${e.campo}`,
    checklistItem: 'deduccion.continuidad',
    descripcion:
      `${e.nombre} aparece con distinta ${etiquetaCampo(e.campo)} según la lámina: ${enumerar(lecturas)}. ` +
      'No la deduzco: decidí cuál vale.',
    fuentes: fuentesDeEntidades(e.portadores),
  });
}
