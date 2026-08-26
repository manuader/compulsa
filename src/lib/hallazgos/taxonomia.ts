/**
 * Taxonomía de huecos (PRD §11) y constructores de hallazgos.
 *
 * Todo dato que un rubro necesita cae en exactamente una de cinco clases:
 * `explicito`, `deducible`, `supuesto`, `existente`, `faltante`. La regla dura
 * es P4: **el sistema jamás rellena un dato**. Lo que no está y no se deduce
 * sale como hallazgo a la bandeja, nunca como un número inventado.
 *
 * Acá viven también los lectores de atributos (`leerNumero`, `leerMedida`,
 * `leerTexto`): decidir si un dato está o no está ES la clasificación, y las
 * cuatro plantillas de rubro necesitan tomar esa decisión igual.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import { fuentesDeEntidades } from '@/lib/computo/presentacion';
import type { EstadoReforma, Fuente, HallazgoDetectado, RubroId, TipoHallazgo } from '@/types/domain';

// ---------------------------------------------------------------------------
// Las cinco clases (§11)
// ---------------------------------------------------------------------------

export type ClaseHueco = 'explicito' | 'deducible' | 'supuesto' | 'existente' | 'faltante';

export const CLASES_HUECO = [
  'explicito',
  'deducible',
  'supuesto',
  'existente',
  'faltante',
] as const satisfies readonly ClaseHueco[];

/** Qué tipo de hallazgo genera cada clase (las resueltas no generan ninguno). */
export const TIPO_POR_CLASE: Record<ClaseHueco, TipoHallazgo | null> = {
  explicito: null,
  deducible: null,
  supuesto: 'supuesto',
  existente: 'existente_confirmar',
  faltante: 'faltante',
};

/** Solo el faltante real frena la aprobación del rubro (RF-404). */
export const BLOQUEANTE_POR_CLASE: Record<ClaseHueco, boolean> = {
  explicito: false,
  deducible: false,
  supuesto: false,
  existente: false,
  faltante: true,
};

/** Umbral de la regla de oro §11.b: por debajo, todo degrada a consulta. */
export const UMBRAL_CONFIANZA = 0.7;

export interface EntradaHueco {
  /** El dato tal como aparece en la documentación, si aparece. */
  valorExplicito?: number | string | boolean | null;
  /** Deducción documental (≥ 2 fuentes de la misma doc) con su regla. */
  deduccion?: { valor: number | string; regla: string; fuentes: Fuente[]; confianza: number };
  /** Supuesto normativo/estándar aplicable, citando la norma. */
  supuestoEstandar?: { valor: number | string; norma: string };
  /** Contexto de reforma: si el elemento ya está construido, el dato no falta. */
  estadoReforma?: EstadoReforma;
  /** Datos de índole estructural o de seguridad (RF-506). */
  estructural?: boolean;
}

export interface Clasificacion {
  clase: ClaseHueco;
  tipo: TipoHallazgo | null;
  bloqueante: boolean;
  motivo: string;
}

/**
 * Clasifica un dato faltante según §11. El orden importa: lo explícito manda,
 * después el contexto de reforma, después RF-506 (nada estructural se
 * auto-deduce), y recién ahí deducción → supuesto → faltante real.
 */
export function clasificarHueco(entrada: EntradaHueco): Clasificacion {
  const armar = (clase: ClaseHueco, motivo: string): Clasificacion => ({
    clase,
    tipo: TIPO_POR_CLASE[clase],
    bloqueante: BLOQUEANTE_POR_CLASE[clase],
    motivo,
  });

  if (entrada.valorExplicito !== undefined && entrada.valorExplicito !== null && entrada.valorExplicito !== '') {
    return armar('explicito', 'El dato está en la documentación.');
  }
  if (entrada.estadoReforma === 'existente') {
    return armar('existente', 'El elemento ya está construido: no está dentro del alcance de la obra.');
  }
  if (entrada.estructural) {
    return armar('faltante', 'Dato estructural o de seguridad: consultá al profesional competente.');
  }
  if (entrada.deduccion) {
    return entrada.deduccion.confianza >= UMBRAL_CONFIANZA
      ? armar('deducible', `Deducido por "${entrada.deduccion.regla}"; requiere validación.`)
      : armar('faltante', `La deducción "${entrada.deduccion.regla}" quedó por debajo del umbral de confianza.`);
  }
  if (entrada.supuestoEstandar) {
    return armar('supuesto', `Propuesto según ${entrada.supuestoEstandar.norma}; confirmalo antes de computar.`);
  }
  return armar('faltante', 'No hay fuente ni regla que lo resuelva.');
}

// ---------------------------------------------------------------------------
// Reglas de reforma
// ---------------------------------------------------------------------------

/** Qué computa una entidad según su estado en la reforma. */
export type AlcanceComputo = 'completo' | 'demolicion' | 'ninguno';

export function alcanceDeReforma(estado: EstadoReforma): AlcanceComputo {
  switch (estado) {
    case 'existente':
      return 'ninguno';
    case 'demoler':
      return 'demolicion';
    case 'nueva':
    case 'na':
      return 'completo';
  }
}

// ---------------------------------------------------------------------------
// Lectura de atributos: ¿el dato está, o es un hueco?
// ---------------------------------------------------------------------------

/** Número del atributo, o `null` si no está (tolera números escritos como texto). */
export function leerNumero(entidad: EntidadPersistida, campo: string): number | null {
  const valor = entidad.atributos[campo];
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && valor.trim() !== '') {
    const parseado = Number(valor.replace(',', '.'));
    return Number.isFinite(parseado) ? parseado : null;
  }
  return null;
}

/** Medida física: además de estar, tiene que ser positiva. */
export function leerMedida(entidad: EntidadPersistida, campo: string): number | null {
  const valor = leerNumero(entidad, campo);
  return valor !== null && valor > 0 ? valor : null;
}

/** Texto del atributo, o `null` si no está. */
export function leerTexto(entidad: EntidadPersistida, campo: string): string | null {
  const valor = entidad.atributos[campo];
  if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Constructores de hallazgos (una sola forma para todo el motor)
// ---------------------------------------------------------------------------

export interface EntradaDatoFaltante {
  rubro: RubroId | null;
  /** Única por obra, para idempotencia: "seco.altura_tabiques.T1". */
  clave: string;
  /** Familia de la clave, o sea el ítem del checklist: "seco.altura_tabiques". */
  checklistItem?: string;
  descripcion: string;
  entidad: EntidadPersistida;
  /** Campo que se completa al responder el hallazgo. */
  campo: string;
}

/** Clase 5: faltante real. Bloquea la aprobación del rubro. */
export function hallazgoDatoFaltante(entrada: EntradaDatoFaltante): HallazgoDetectado {
  return {
    tipo: 'faltante',
    rubro: entrada.rubro,
    descripcion: entrada.descripcion,
    clave: entrada.clave,
    ...(entrada.checklistItem ? { checklistItem: entrada.checklistItem } : {}),
    bloqueante: true,
    fuentes: fuentesDeEntidades([entrada.entidad]),
    targetRef: { entidadId: entrada.entidad.id, campo: entrada.campo },
  };
}

export interface EntradaSupuesto {
  rubro: RubroId | null;
  clave: string;
  checklistItem?: string;
  descripcion: string;
  entidades: readonly EntidadPersistida[];
}

/** Clase 3: se computó sobre un supuesto declarado. No bloquea, pero se avisa. */
export function hallazgoSupuesto(entrada: EntradaSupuesto): HallazgoDetectado {
  return {
    tipo: 'supuesto',
    rubro: entrada.rubro,
    descripcion: entrada.descripcion,
    clave: entrada.clave,
    ...(entrada.checklistItem ? { checklistItem: entrada.checklistItem } : {}),
    bloqueante: false,
    fuentes: fuentesDeEntidades(entrada.entidades),
  };
}

export interface EntradaInconsistencia {
  rubro: RubroId | null;
  clave: string;
  checklistItem?: string;
  descripcion: string;
  fuentes: Fuente[];
}

/** Dos datos de la documentación que no cierran entre sí (sanity checks). */
export function hallazgoInconsistencia(entrada: EntradaInconsistencia): HallazgoDetectado {
  return {
    tipo: 'inconsistencia',
    rubro: entrada.rubro,
    descripcion: entrada.descripcion,
    clave: entrada.clave,
    ...(entrada.checklistItem ? { checklistItem: entrada.checklistItem } : {}),
    bloqueante: false,
    fuentes: entrada.fuentes,
  };
}

export interface EntradaBajaConfianza {
  rubro: RubroId;
  /** Clave del ítem que NO se emitió: "seco.placas". */
  claveItem: string;
  descripcion: string;
  confianza: number;
  fuentes: Fuente[];
}

/**
 * Regla de oro §11.b: confianza por debajo del umbral ⇒ el ítem no se emite y
 * el dato se degrada a consulta bloqueante.
 */
export function hallazgoBajaConfianza(entrada: EntradaBajaConfianza): HallazgoDetectado {
  const prefijo = `${entrada.rubro}.`;
  const sufijo = entrada.claveItem.startsWith(prefijo)
    ? entrada.claveItem.slice(prefijo.length)
    : entrada.claveItem;
  const porcentaje = Math.round(entrada.confianza * 100);
  const umbral = Math.round(UMBRAL_CONFIANZA * 100);

  return {
    tipo: 'faltante',
    rubro: entrada.rubro,
    descripcion:
      `No computé "${entrada.descripcion}": los datos que lo sostienen tienen ${porcentaje}% de confianza, ` +
      `por debajo del ${umbral}% que hace falta para computarlo sin preguntar. Revisá la documentación y confirmá el dato.`,
    clave: `${entrada.rubro}.baja_confianza.${sufijo}`,
    checklistItem: `${entrada.rubro}.baja_confianza`,
    bloqueante: true,
    fuentes: entrada.fuentes,
  };
}
