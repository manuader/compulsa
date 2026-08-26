/**
 * Regla `cierre_cotas` (§11 PRD) — factor 0,9.
 *
 * La aritmética más vieja del oficio: sobre un mismo elemento, la cota total
 * menos la suma de las parciales da la parcial que el plano no acotó.
 *
 * Trabaja sobre entidades `tipo='cota'` con atributos `{ valorM, sobre, tramo }`.
 * La cota cuyo `tramo` es `total` es el total del elemento; las demás son los
 * parciales. Tres desenlaces posibles, y solo uno es una deducción:
 *
 *   - **falta exactamente un parcial** → se despeja y se propone;
 *   - **están todos y no suman** (± 1%) → `inconsistencia`, nunca una cota
 *     "corregida": el motor no elige por el arquitecto;
 *   - **faltan dos o más** → el sistema de una ecuación tiene dos incógnitas:
 *     no hay nada que deducir y el hueco queda para la bandeja.
 *
 * Es la única regla que propone `valorM`, que es el dato propio de una cota.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { fuentesDeEntidades } from '@/lib/computo/presentacion';
import { formatearNumero, redondear2 } from '@/lib/computo/unidades';
import type { CandidatoDeduccion, ContextoDeduccion, SalidaRegla } from '@/lib/deduccion/motor';
import { describirValor, enumerar, leerCampo } from '@/lib/deduccion/motor';
import { hallazgoInconsistencia, leerTexto } from '@/lib/hallazgos/taxonomia';
import type { HallazgoDetectado } from '@/types/domain';

const CAMPO = 'valorM';

/** El `tramo` que marca la cota total del elemento. */
const TRAMO_TOTAL = 'total';

/** Cuánto puede desviarse la suma de los parciales respecto de la total. */
export const TOLERANCIA_CIERRE = 0.01;

/** Margen para que el 1% justo no dispare por ruido binario. */
const EPSILON = 1e-9;

export function deducirCierreCotas(
  entidades: readonly EntidadPersistida[],
  ctx: ContextoDeduccion,
): SalidaRegla {
  const candidatos: CandidatoDeduccion[] = [];
  const inconsistencias: HallazgoDetectado[] = [];

  for (const [sobre, cotas] of agruparPorElementoAcotado(entidades)) {
    const total = cotas.find((cota) => tramoDe(cota) === TRAMO_TOTAL && leerCampo(cota, CAMPO) !== null);
    if (total === undefined) continue; // sin total no hay nada que cerrar

    const parciales = cotas.filter((cota) => cota !== total && tramoDe(cota) !== TRAMO_TOTAL);
    const conValor = parciales.filter((cota) => leerCampo(cota, CAMPO) !== null);
    const sinValor = parciales.filter((cota) => leerCampo(cota, CAMPO) === null);
    if (conValor.length === 0) continue;

    const valorTotal = leerCampo(total, CAMPO)!;
    const suma = redondear2(conValor.reduce((acc, cota) => acc + leerCampo(cota, CAMPO)!, 0));

    if (sinValor.length > 1) continue; // dos incógnitas, una sola ecuación

    if (sinValor.length === 0) {
      const desvio = Math.abs(suma - valorTotal) / valorTotal;
      if (desvio <= TOLERANCIA_CIERRE + EPSILON) continue;
      inconsistencias.push(noCierra({ sobre, suma, valorTotal, desvio, cotas: [total, ...conValor] }));
      continue;
    }

    const faltante = redondear2(valorTotal - suma);
    const destino = sinValor[0]!;
    if (faltante <= 0) {
      inconsistencias.push(seExcede({ sobre, suma, valorTotal, tramo: tramoDe(destino), cotas: [total, ...conValor, destino] }));
      continue;
    }

    const aportes = [destino, total, ...conValor];
    candidatos.push({
      destino,
      campo: CAMPO,
      valor: faltante,
      aportes,
      explicacion:
        `El tramo ${tramoDe(destino)} sobre ${sobre} mide ${describirValor(CAMPO, faltante)} por cierre de cotas: ` +
        `la cota total ${describirValor(CAMPO, valorTotal)} menos los parciales ` +
        `${enumerar(conValor.map((cota) => describirValor(CAMPO, leerCampo(cota, CAMPO)!)))} ` +
        `(lámina ${ctx.codigoLamina(total)}).`,
    });
  }

  return { candidatos, inconsistencias };
}

/** El elemento que las cotas acotan ("muro M1"), en orden de aparición. */
function agruparPorElementoAcotado(
  entidades: readonly EntidadPersistida[],
): Map<string, EntidadPersistida[]> {
  const grupos = new Map<string, EntidadPersistida[]>();
  for (const entidad of entidades) {
    if (entidad.tipo !== 'cota') continue;
    const sobre = leerTexto(entidad, 'sobre');
    if (sobre === null) continue;
    const grupo = grupos.get(sobre);
    if (grupo) grupo.push(entidad);
    else grupos.set(sobre, [entidad]);
  }
  return grupos;
}

function tramoDe(cota: EntidadPersistida): string {
  return leerTexto(cota, 'tramo') ?? '';
}

interface EntradaNoCierra {
  sobre: string;
  suma: number;
  valorTotal: number;
  desvio: number;
  cotas: readonly EntidadPersistida[];
}

function noCierra(e: EntradaNoCierra): HallazgoDetectado {
  return hallazgoInconsistencia({
    rubro: null,
    clave: `deduccion.cotas.${e.sobre}`,
    checklistItem: 'deduccion.cierre_cotas',
    descripcion:
      `Las cotas parciales sobre ${e.sobre} suman ${describirValor(CAMPO, e.suma)} contra una total de ` +
      `${describirValor(CAMPO, e.valorTotal)}: ${formatearNumero(redondear2(e.desvio * 100))}% de diferencia, ` +
      `más del ${formatearNumero(TOLERANCIA_CIERRE * 100)}% que tolera el cierre de cotas. Revisá cuál cota vale.`,
    fuentes: fuentesDeEntidades(e.cotas),
  });
}

interface EntradaSeExcede {
  sobre: string;
  suma: number;
  valorTotal: number;
  tramo: string;
  cotas: readonly EntidadPersistida[];
}

function seExcede(e: EntradaSeExcede): HallazgoDetectado {
  return hallazgoInconsistencia({
    rubro: null,
    clave: `deduccion.cotas.${e.sobre}`,
    checklistItem: 'deduccion.cierre_cotas',
    descripcion:
      `Los parciales sobre ${e.sobre} ya suman ${describirValor(CAMPO, e.suma)} contra una total de ` +
      `${describirValor(CAMPO, e.valorTotal)}, y todavía falta el tramo ${e.tramo}. ` +
      'Revisá las cotas antes de computar.',
    fuentes: fuentesDeEntidades(e.cotas),
  });
}
