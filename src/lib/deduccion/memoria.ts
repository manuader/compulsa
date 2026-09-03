/**
 * Memoria de deducciones (RF-505).
 *
 * El documento que el estudio adjunta al expediente y que responde, sin que
 * haga falta abrir la plataforma, las cuatro preguntas del PRD: **qué** se
 * dedujo, **de dónde** salió, **quién** lo validó o lo rechazó y **cuándo**.
 *
 * Es markdown es-AR plano —sin HTML, sin dependencias— así que sirve igual para
 * pegar en un mail, exportar a PDF o versionar junto al proyecto. Una tabla por
 * regla, en el mismo orden de prioridad con el que corre el motor, para que se
 * lea de la deducción más sólida a la más floja.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import { describirValor, etiquetaCampo, PRIORIDAD_REGLAS, type DeduccionPropuesta, type LaminaResumen } from '@/lib/deduccion/motor';
import type { EstadoDeduccion, Fuente, ReglaDeduccion } from '@/types/domain';

/** Una deducción con lo que pasó después: el estado y la firma de quien decidió. */
export type DeduccionRegistrada = DeduccionPropuesta & {
  estado: EstadoDeduccion;
  /** Quién validó o rechazó. Vacío mientras la deducción sigue en propuesta. */
  validadoPor?: string;
  /** Cuándo se decidió, como se guarda (ISO) o como se muestra. */
  fecha?: string;
};

/** Título de cada sección: el nombre de la regla en criollo. */
export const TITULO_REGLA: Record<ReglaDeduccion, string> = {
  planilla_plano: 'Planilla ↔ plano',
  planta_corte: 'Planta ↔ corte',
  continuidad: 'Continuidad entre láminas',
  idem_tipologia: 'Ídem tipología',
  cierre_cotas: 'Cierre de cotas',
  cruce: 'Cruce de información del expediente',
  medicion_grafica: 'Medición gráfica sobre el dibujo',
};

const ESTADO_LEGIBLE: Record<EstadoDeduccion, string> = {
  propuesta: 'Propuesta',
  validada: 'Validada',
  rechazada: 'Rechazada',
};

const COLUMNAS = [
  'Entidad',
  'Campo',
  'Valor',
  'Confianza',
  'Fuentes',
  'Estado',
  'Validó / rechazó',
  'Fecha',
  'Por qué',
] as const;

/** Celda vacía: se ve el hueco, no un espacio que parece un error de armado. */
const VACIO = '—';

/**
 * El descargo del PRD §12: la plataforma asiste, el que firma es el arquitecto.
 * Va en toda memoria porque el documento sale del estudio hacia afuera.
 */
const DESCARGO =
  '_La plataforma asiste: el cómputo y las deducciones los firma el profesional interviniente. ' +
  'Nada de índole estructural o de seguridad se deduce automáticamente (RF-506)._';

/**
 * Arma la memoria en markdown.
 *
 * `laminas` es opcional y solo mejora la lectura: con ella las fuentes se citan
 * por código de lámina ("A-01"), sin ella por id, que sigue siendo trazable.
 */
export function generarMemoria(
  deducciones: readonly DeduccionRegistrada[],
  laminas: readonly LaminaResumen[] = [],
): string {
  const lineas: string[] = ['# Memoria de deducciones', ''];

  if (deducciones.length === 0) {
    lineas.push('No hay deducciones registradas en esta obra.', '');
  } else {
    lineas.push(resumen(deducciones), '');
    const codigos = new Map(laminas.map((lamina) => [lamina.id, lamina.codigo]));
    for (const regla of PRIORIDAD_REGLAS) {
      const delGrupo = deducciones.filter((deduccion) => deduccion.regla === regla);
      if (delGrupo.length === 0) continue;
      lineas.push(`## ${TITULO_REGLA[regla]}`, '');
      lineas.push(fila(COLUMNAS), fila(COLUMNAS.map(() => '---')));
      for (const deduccion of delGrupo) lineas.push(fila(celdas(deduccion, codigos)));
      lineas.push('');
    }
  }

  lineas.push('---', '', DESCARGO);
  return `${lineas.join('\n')}\n`;
}

/** "3 deducciones: 1 validada, 1 rechazada, 1 pendiente de validación." */
function resumen(deducciones: readonly DeduccionRegistrada[]): string {
  const contar = (estado: EstadoDeduccion): number =>
    deducciones.filter((deduccion) => deduccion.estado === estado).length;
  const total = deducciones.length;
  const validadas = contar('validada');
  const rechazadas = contar('rechazada');
  const pendientes = contar('propuesta');

  return (
    `${total} ${total === 1 ? 'deducción' : 'deducciones'}: ` +
    `${validadas} ${validadas === 1 ? 'validada' : 'validadas'}, ` +
    `${rechazadas} ${rechazadas === 1 ? 'rechazada' : 'rechazadas'}, ` +
    `${pendientes} ${pendientes === 1 ? 'pendiente' : 'pendientes'} de validación.`
  );
}

function celdas(deduccion: DeduccionRegistrada, codigos: Map<string, string | null>): string[] {
  return [
    nombreEntidad(deduccion),
    etiquetaCampo(deduccion.campo),
    describirValor(deduccion.campo, deduccion.valor),
    `${Math.round(deduccion.confianza * 100)}%`,
    citarFuentes(deduccion.fuentes, codigos),
    ESTADO_LEGIBLE[deduccion.estado],
    deduccion.validadoPor ?? VACIO,
    deduccion.fecha ?? VACIO,
    deduccion.explicacion,
  ];
}

/**
 * Cómo se llama la entidad en la memoria. El `detalle` de la primera fuente es
 * el nombre con el que la entidad entró al sistema; si no está, el id sirve:
 * la trazabilidad no se pierde nunca.
 */
function nombreEntidad(deduccion: DeduccionRegistrada): string {
  return deduccion.fuentes[0]?.detalle ?? deduccion.entidadId;
}

/** "A-01, A-05" — láminas sin repetir, en el orden en que sostienen la deducción. */
function citarFuentes(fuentes: readonly Fuente[], codigos: Map<string, string | null>): string {
  const citas = fuentes.map((fuente) => {
    if (!codigos.has(fuente.laminaId)) return fuente.laminaId;
    return codigos.get(fuente.laminaId) ?? 'sin código';
  });
  return [...new Set(citas)].join(', ');
}

/** Una fila de markdown, con los pipes del contenido escapados. */
function fila(valores: readonly string[]): string {
  return `| ${valores.map((valor) => valor.replaceAll('|', '\\|')).join(' | ')} |`;
}
