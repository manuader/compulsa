/**
 * Vocabulario compartido del cruce del expediente.
 *
 * Es la **quinta** familia de providers del módulo, hermana de `tipos.ts`
 * (láminas), `presupuesto-tipos.ts`, `qa-tipos.ts` y `busqueda-tipos.ts`. Las
 * otras cuatro miran **una** lámina; esta mira el expediente entero, ya
 * compactado a texto por `src/lib/memoria/compacta.ts`, y contesta lo único que
 * no se puede contestar lámina por lámina: qué dato de una lámina completa el
 * hueco de otra, qué elementos de dos láminas son el mismo, qué se contradice y
 * qué lámina conviene releer.
 *
 * ## Códigos de lámina, no uuids
 *
 * El modelo lee "PL01" y "DET00" en los rótulos; no conoce —ni tiene por qué
 * conocer— los uuids de `laminas`. Por eso todo lo que sale de acá cita la
 * lámina por **código** y `sanearCruce()` lo resuelve contra el expediente
 * real. Un código que no existe no se corrige ni se adivina: se descarta y se
 * cuenta. Es la misma disciplina de `sanearBusqueda()` con los objetivos que
 * nadie pidió.
 *
 * ## Por qué `cruzar()` devuelve el crudo y no el saneado
 *
 * El saneo necesita el mapa de códigos y la lista de entidades de la obra, que
 * son cosas de la base: dárselas al provider lo obligaría a saber de dónde
 * salen. Así, el provider —mock o Claude— devuelve lo que dijo el modelo y el
 * pipeline lo pasa por `sanearCruce()`. Un solo saneo, el mismo para las dos
 * implementaciones, y un fixture no puede colar nada que el modelo no pudiera
 * decir.
 *
 * ## Qué NO hace esto
 *
 * No escribe nada. Ni `atributos_json`, ni `datos_obra`, ni deducciones: las
 * decide el pipeline (`src/lib/pipeline/cruce.ts`), que además aplica el umbral
 * de auto-validación. Y la IA **jamás** pone un precio.
 */
import { z } from 'zod';

import { normalizarTag } from '@/lib/computo/tags';
import { esCampoDeducible } from '@/lib/deduccion/motor';
import { UNIDADES, type BBox, type Fuente, type ObraContexto, type TipoEntidad, type Unidad } from '@/types/domain';

// Ciclo de imports a propósito, igual que en `busqueda-tipos.ts`, `qa-tipos.ts`
// y `presupuesto-tipos.ts`: los dos providers dependen de este módulo para el
// contrato y este solo los usa dentro de `getCruceProvider()`, nunca en la
// evaluación del módulo.
import { crearProviderCruceClaude } from './cruce-claude';
import { crearProviderCruceMock } from './cruce-mock';

// ---------------------------------------------------------------------------
// El cable, laxo a propósito
// ---------------------------------------------------------------------------

/**
 * Lo que puede faltar viaja como `null`, no como clave ausente: es la
 * convención del módulo para la gramática de structured outputs (ver
 * `zRotuloDetectado`), que garantiza las claves pero no los rangos ni los
 * largos de array.
 *
 * **Todos los valores son `string`.** Mismo motivo que en la búsqueda dirigida:
 * evita un `anyOf` en la gramática, y una lámina argentina escribe `2,60`. Que
 * el modelo transcriba lo escrito y que la conversión con coma decimal la haga
 * nuestro código es más honesto que pedírsela a él.
 */
export const zRespuestaCruceCruda = z.object({
  /** Hechos que valen para toda la obra: `altura_local.PB`, `nivel.PB`. */
  datosObra: z.array(
    z.object({
      clave: z.string(),
      valor: z.string(),
      unidad: z.string().nullable(),
      laminaCodigo: z.string(),
      bbox: z.array(z.number()).nullable(),
      confianza: z.number(),
    }),
  ),
  /** Un campo que falta en una entidad y está escrito en otra lámina. */
  completados: z.array(
    z.object({
      laminaCodigo: z.string(),
      entidadNombre: z.string(),
      campo: z.string(),
      valor: z.string(),
      fuenteLaminaCodigo: z.string(),
      bbox: z.array(z.number()).nullable(),
      confianza: z.number(),
    }),
  ),
  /** Grupos de entidades que son el mismo elemento físico (§15). */
  identidades: z.array(
    z.array(z.object({ laminaCodigo: z.string(), entidadNombre: z.string() })),
  ),
  /** Dato A contra dato B, cada uno con su lámina (§17). */
  conflictos: z.array(
    z.object({
      descripcion: z.string(),
      datoA: z.string(),
      laminaCodigoA: z.string(),
      datoB: z.string(),
      laminaCodigoB: z.string(),
      causaPosible: z.string().nullable(),
    }),
  ),
  /** Qué lámina conviene volver a mirar y buscando qué. */
  relecturas: z.array(z.object({ laminaCodigo: z.string(), queBuscar: z.string() })),
});

export type RespuestaCruceCruda = z.infer<typeof zRespuestaCruceCruda>;

// ---------------------------------------------------------------------------
// Lo que el saneo acepta
// ---------------------------------------------------------------------------

/**
 * Supertipo de lo que puede llegar por el cable y de lo que puede traer un
 * fixture: los opcionales pueden venir ausentes **o** en `null`, y una medida
 * puede venir ya como número. Las dos implementaciones entran por la misma
 * puerta.
 */
export interface DatoObraCrudo {
  clave: string;
  valor: number | string;
  unidad?: string | null;
  laminaCodigo: string;
  bbox?: readonly number[] | null;
  confianza: number;
}

export interface CompletadoCrudo {
  laminaCodigo: string;
  entidadNombre: string;
  campo: string;
  valor: number | string;
  fuenteLaminaCodigo: string;
  bbox?: readonly number[] | null;
  confianza: number;
}

export interface RefEntidadCruda {
  laminaCodigo: string;
  entidadNombre: string;
}

export interface ConflictoCrudo {
  descripcion: string;
  datoA: string;
  laminaCodigoA: string;
  datoB: string;
  laminaCodigoB: string;
  causaPosible?: string | null;
}

export interface RelecturaCruda {
  laminaCodigo: string;
  queBuscar: string;
}

export interface CruceCrudo {
  datosObra: readonly DatoObraCrudo[];
  completados: readonly CompletadoCrudo[];
  identidades: readonly (readonly RefEntidadCruda[])[];
  conflictos: readonly ConflictoCrudo[];
  relecturas: readonly RelecturaCruda[];
}

// ---------------------------------------------------------------------------
// Lo que el saneo devuelve
// ---------------------------------------------------------------------------

/** Un hecho de la obra, con su provenance. Va directo a `datos_obra`. */
export interface DatoObraCruzado {
  clave: string;
  valor: number | string;
  unidad?: Unidad;
  fuentes: Fuente[];
  confianza: number;
}

/** Un campo de una entidad, leído en otra lámina. Va a `deducciones`. */
export interface CampoCompletado {
  entidadId: string;
  campo: string;
  /** Todo campo de `CAMPOS_DEDUCIBLES` es una medida: siempre número, siempre > 0. */
  valor: number;
  fuentes: Fuente[];
  confianza: number;
}

/** Dos lecturas de la misma cosa que no coinciden (§17). */
export interface ConflictoCruce {
  descripcion: string;
  datoA: string;
  laminaIdA: string;
  datoB: string;
  laminaIdB: string;
  causaPosible?: string;
}

/** "Volvé a mirar esta lámina buscando esto." Alimenta la fase de relectura. */
export interface RelecturaPedida {
  laminaId: string;
  queBuscar: string;
}

/** Cuánto se tiró, por categoría. Es lo que se audita (RNF-7). */
export interface DescartesCruce {
  datosObra: number;
  completados: number;
  identidades: number;
  conflictos: number;
  relecturas: number;
}

export interface ResultadoCruce {
  datosObra: DatoObraCruzado[];
  completados: CampoCompletado[];
  /** Grupos de ≥ 2 ids de entidad distintos. */
  identidades: string[][];
  conflictos: ConflictoCruce[];
  relecturas: RelecturaPedida[];
  descartados: DescartesCruce;
}

// ---------------------------------------------------------------------------
// El expediente contra el que se resuelve
// ---------------------------------------------------------------------------

/** Lo mínimo de una entidad para poder reconocerla por lo que el modelo escribió. */
export interface EntidadDelCruce {
  id: string;
  laminaId: string;
  nombre: string;
  tipo: TipoEntidad;
}

/**
 * El expediente real, para traducir lo que dice el modelo. Lo arma el pipeline
 * leyendo `laminas` y `entidades` de la obra.
 */
export interface ContextoCruce {
  /** Código de rótulo → `laminas.id`. */
  laminasPorCodigo: ReadonlyMap<string, string>;
  entidades: readonly EntidadDelCruce[];
}

// ---------------------------------------------------------------------------
// La interfaz
// ---------------------------------------------------------------------------

/**
 * La frontera con el mundo no determinístico, del lado del cruce. Dos
 * implementaciones: `crearProviderCruceMock()` y `crearProviderCruceClaude()`.
 *
 * Una llamada = una obra. `memoria` es el expediente compactado a texto
 * (`src/lib/memoria/compacta.ts`): el cruce no vuelve a mirar los PDFs, mira lo
 * que la extracción ya leyó de todos ellos junto.
 */
export interface CruceProvider {
  /**
   * Quién contestó. Va a la auditoría y sirve para lo mismo que en la búsqueda
   * dirigida: distinguir "el mock no tenía fixture" de "el modelo no encontró
   * nada" cuando alguien mire por qué una obra no cruzó nada.
   */
  readonly nombre: string;

  cruzar(memoria: string, ctx: ObraContexto): Promise<RespuestaCruceCruda>;
}

// ---------------------------------------------------------------------------
// Saneo
// ---------------------------------------------------------------------------

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Mismo criterio que `leerNumero()` de la taxonomía: tolera la coma decimal. */
function comoNumero(valor: number | string): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (valor.trim() === '') return null;
  const parseado = Number(valor.replace(',', '.'));
  return Number.isFinite(parseado) ? parseado : null;
}

const UNIDADES_VALIDAS: ReadonlySet<string> = new Set(UNIDADES);

/**
 * La fuente de un dato citado (P1).
 *
 * Sin bbox usable —ausente, o que no son cuatro números finitos— la fuente es
 * **la lámina completa**, con el mismo `detalle` que usa el pipeline cuando una
 * consulta es sobre la lámina entera. Es la diferencia deliberada con
 * `sanearBusqueda()`, donde un bbox roto descarta el dato: allá el bbox es
 * obligatorio porque la propuesta se dibuja sobre la lámina; acá el modelo cita
 * de memoria un expediente compactado que ya no tiene los PDFs delante, así que
 * exigirle coordenadas sería pedirle que las invente.
 */
function fuenteDe(laminaId: string, bbox: readonly number[] | null | undefined): Fuente {
  if (bbox != null && bbox.length === 4 && bbox.every((n) => Number.isFinite(n))) {
    const [x, y, ancho, alto] = bbox;
    return { laminaId, bbox: [clamp01(x), clamp01(y), clamp01(ancho), clamp01(alto)] as BBox };
  }
  return { laminaId, bbox: [0, 0, 1, 1], detalle: 'Lámina completa' };
}

/**
 * Índice tolerante: primero el código tal cual, después el código normalizado
 * (sin espacios, en mayúsculas — `normalizarTag`), porque el rótulo dice "PL 01"
 * y la base guardó "PL01". Si dos códigos distintos normalizan igual y apuntan a
 * láminas distintas, la entrada normalizada queda ambigua y no resuelve nada:
 * elegir una sería adivinar.
 */
function indexarLaminas(mapa: ReadonlyMap<string, string>): Map<string, string | null> {
  const indice = new Map<string, string | null>();
  for (const [codigo, laminaId] of mapa) {
    const normalizado = normalizarTag(codigo);
    if (!indice.has(normalizado)) indice.set(normalizado, laminaId);
    else if (indice.get(normalizado) !== laminaId) indice.set(normalizado, null);
  }
  return indice;
}

/**
 * Índice de entidades por (lámina, tag normalizado). Dos entidades **distintas**
 * con el mismo tag en la misma lámina dejan la entrada en `null`: el match es
 * ambiguo y completar una de las dos a dedo sería una moneda al aire.
 */
function indexarEntidades(
  entidades: readonly EntidadDelCruce[],
): Map<string, EntidadDelCruce | null> {
  const indice = new Map<string, EntidadDelCruce | null>();
  for (const entidad of entidades) {
    const clave = claveEntidad(entidad.laminaId, entidad.nombre);
    if (!indice.has(clave)) indice.set(clave, entidad);
    else if (indice.get(clave)?.id !== entidad.id) indice.set(clave, null);
  }
  return indice;
}

/**
 * Clave de una entidad en su lámina. El separador es un NUL porque
 * `normalizarTag` le come los espacios al nombre: un separador visible se
 * confundiría con parte del tag.
 */
function claveEntidad(laminaId: string, nombre: string): string {
  return `${laminaId}\u0000${normalizarTag(nombre)}`;
}

/**
 * Aplica el contrato sobre lo que devolvió el cruce.
 *
 * Descarta —y cuenta, por categoría— todo lo que no se puede usar:
 *
 *  - **un código de lámina que no existe** en el expediente (o que resuelve a
 *    dos láminas distintas): sin lámina no hay provenance;
 *  - **una entidad que no está en esa lámina**, o que está dos veces con el
 *    mismo tag: completar una de dos a dedo sería una moneda al aire con
 *    provenance;
 *  - **un campo fuera de `CAMPOS_DEDUCIBLES`** (RF-506): nada estructural ni de
 *    seguridad se auto-propone, y el cruce no es la excepción;
 *  - **un valor no numérico o no positivo en un campo de medida**: "no figura",
 *    "s/d" o "2,05 m" no son medidas;
 *  - **una confianza que no es un número**: no podría competir contra otra
 *    lectura del mismo campo;
 *  - **un grupo de identidad con menos de dos entidades distintas resueltas**:
 *    una entidad sola no es una identidad, es un dato suelto.
 *
 * Lo recuperable se clampa (bbox y confianza a [0,1]) y lo ilegible se afloja:
 * una unidad que no es del dominio se cae sola —la clave del dato de obra ya
 * dice de qué se trata— sin llevarse el número puesto.
 *
 * **No deduplica.** Si vuelven dos lecturas del mismo campo, las dos quedan: con
 * cuál quedarse es del pipeline, que también las hace competir contra las
 * deducciones documentales.
 */
export function sanearCruce(crudo: CruceCrudo, ctx: ContextoCruce): ResultadoCruce {
  const laminasNormalizadas = indexarLaminas(ctx.laminasPorCodigo);
  const entidadesPorClave = indexarEntidades(ctx.entidades);

  const laminaDe = (codigo: string): string | null => {
    const exacto = ctx.laminasPorCodigo.get(codigo.trim());
    if (exacto !== undefined) return exacto;
    return laminasNormalizadas.get(normalizarTag(codigo)) ?? null;
  };

  const entidadDe = (laminaCodigo: string, nombre: string): EntidadDelCruce | null => {
    const laminaId = laminaDe(laminaCodigo);
    if (laminaId === null) return null;
    return entidadesPorClave.get(claveEntidad(laminaId, nombre)) ?? null;
  };

  const descartados: DescartesCruce = {
    datosObra: 0,
    completados: 0,
    identidades: 0,
    conflictos: 0,
    relecturas: 0,
  };

  // --- Datos de obra ---
  const datosObra: DatoObraCruzado[] = [];
  for (const cruce of crudo.datosObra) {
    const clave = cruce.clave.trim();
    const laminaId = laminaDe(cruce.laminaCodigo);
    if (clave === '' || laminaId === null || !Number.isFinite(cruce.confianza)) {
      descartados.datosObra += 1;
      continue;
    }

    // Un dato de obra puede ser una medida (`altura_local.PB`) o un texto
    // (`solado.general`): manda lo que el valor es, no un catálogo de claves.
    // El cero es válido — un nivel puede ser 0,00.
    const numero = comoNumero(cruce.valor);
    const texto = String(cruce.valor).trim();
    if (numero === null && texto === '') {
      descartados.datosObra += 1;
      continue;
    }

    const unidad = cruce.unidad?.trim();
    datosObra.push({
      clave,
      valor: numero ?? texto,
      ...(unidad !== undefined && UNIDADES_VALIDAS.has(unidad)
        ? { unidad: unidad as Unidad }
        : {}),
      fuentes: [fuenteDe(laminaId, cruce.bbox)],
      confianza: clamp01(cruce.confianza),
    });
  }

  // --- Campos completados ---
  const completados: CampoCompletado[] = [];
  for (const cruce of crudo.completados) {
    const entidad = entidadDe(cruce.laminaCodigo, cruce.entidadNombre);
    const campo = cruce.campo.trim();
    const fuenteLaminaId = laminaDe(cruce.fuenteLaminaCodigo);
    if (
      entidad === null ||
      fuenteLaminaId === null ||
      !esCampoDeducible(entidad.tipo, campo) ||
      !Number.isFinite(cruce.confianza)
    ) {
      descartados.completados += 1;
      continue;
    }

    const valor = comoNumero(cruce.valor);
    if (valor === null || valor <= 0) {
      descartados.completados += 1;
      continue;
    }

    completados.push({
      entidadId: entidad.id,
      campo,
      valor,
      fuentes: [fuenteDe(fuenteLaminaId, cruce.bbox)],
      confianza: clamp01(cruce.confianza),
    });
  }

  // --- Identidades ---
  const identidades: string[][] = [];
  for (const grupo of crudo.identidades) {
    const ids: string[] = [];
    for (const ref of grupo) {
      const entidad = entidadDe(ref.laminaCodigo, ref.entidadNombre);
      if (entidad !== null && !ids.includes(entidad.id)) ids.push(entidad.id);
    }
    if (ids.length < 2) {
      descartados.identidades += 1;
      continue;
    }
    identidades.push(ids);
  }

  // --- Conflictos ---
  const conflictos: ConflictoCruce[] = [];
  for (const cruce of crudo.conflictos) {
    const descripcion = cruce.descripcion.trim();
    const datoA = cruce.datoA.trim();
    const datoB = cruce.datoB.trim();
    const laminaIdA = laminaDe(cruce.laminaCodigoA);
    const laminaIdB = laminaDe(cruce.laminaCodigoB);
    if (
      descripcion === '' ||
      datoA === '' ||
      datoB === '' ||
      laminaIdA === null ||
      laminaIdB === null
    ) {
      descartados.conflictos += 1;
      continue;
    }

    const causaPosible = cruce.causaPosible?.trim();
    conflictos.push({
      descripcion,
      datoA,
      laminaIdA,
      datoB,
      laminaIdB,
      ...(causaPosible !== undefined && causaPosible !== '' ? { causaPosible } : {}),
    });
  }

  // --- Relecturas ---
  const relecturas: RelecturaPedida[] = [];
  for (const cruce of crudo.relecturas) {
    const laminaId = laminaDe(cruce.laminaCodigo);
    const queBuscar = cruce.queBuscar.trim();
    if (laminaId === null || queBuscar === '') {
      descartados.relecturas += 1;
      continue;
    }
    relecturas.push({ laminaId, queBuscar });
  }

  return { datosObra, completados, identidades, conflictos, relecturas, descartados };
}

/** Las cinco listas vacías: sin fixture, sin memoria o sin nada que decir. */
export function cruceVacio(): RespuestaCruceCruda {
  return { datosObra: [], completados: [], identidades: [], conflictos: [], relecturas: [] };
}

// ---------------------------------------------------------------------------
// Elección de implementación
// ---------------------------------------------------------------------------

/**
 * Claude solo con `ANTHROPIC_API_KEY` **y** fuera de tests; si no, el mock.
 *
 * Misma condición y mismo motivo que las otras cuatro familias: ninguna suite
 * sale a la red ni gasta tokens aunque la key esté exportada en la máquina. Acá
 * pesa más que en ninguna: el cruce manda el expediente entero en una sola
 * llamada.
 */
export function getCruceProvider(): CruceProvider {
  if (process.env.NODE_ENV !== 'test' && process.env.ANTHROPIC_API_KEY) {
    return crearProviderCruceClaude();
  }
  return crearProviderCruceMock();
}
