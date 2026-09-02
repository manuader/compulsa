/**
 * Resumen ejecutivo de la obra (RF-205): qué es, qué alcance tiene, qué
 * documentación falta y qué está preguntando el sistema.
 *
 * **Sin LLM y determinístico.** Es una decisión de producto, no una limitación:
 * el resumen es lo primero que el arquitecto lee cuando vuelve a una obra
 * después de dos semanas, y tiene que decir exactamente lo que está en la base.
 * Un párrafo generado por un modelo podría redondear un número o suavizar una
 * ausencia; acá cada línea se puede señalar con el dedo contra una tabla. La
 * única prosa es la del titular, y sale de un template con los números adentro.
 *
 * Dos mitades, como el resto del pipeline:
 *
 *  - `generarResumen()` es **pura**: entra el estado de la obra, sale el
 *    resumen. Se testea sin base y se pinnea con números concretos.
 *  - `persistirResumen()` es la que toca la base: lee, llama a la pura y guarda
 *    en `obras.resumen_json` (columna de P1). La corre `procesarDocumento` al
 *    final de cada análisis.
 *
 * El orden de todo lo que devuelve es fijo (el de `RUBROS`, `DISCIPLINAS`,
 * `TIPOS_LAMINA`, y por clave dentro de cada lista): dos corridas sobre el mismo
 * estado producen el mismo JSON byte por byte, así que `igualJson` alcanza para
 * no reescribir la fila ni auditar de más.
 */
import { eq } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { deducciones, entidades, hallazgos, laminas, obras, type Obra } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import {
  computarObra,
  type CamposDeducidos,
  type DatosObraResueltos,
  type EntidadPersistida,
} from '@/lib/computo/engine';
import { igualJson } from '@/lib/pipeline/json';
import {
  aplicarDeduccionesValidadas,
  comoEntidadPersistida,
  datosDeObra,
  ACTOR_PIPELINE,
  ObraInexistenteError,
} from '@/lib/pipeline/recomputar';
import { PLANTILLAS } from '@/lib/rubros/index';
import {
  DISCIPLINAS,
  RUBROS,
  TIPOS_LAMINA,
  type Disciplina,
  type EstadoAnalisis,
  type RubroId,
  type TipoLamina,
  type TipoObra,
} from '@/types/domain';

// ---------------------------------------------------------------------------
// El shape del resumen
// ---------------------------------------------------------------------------

/** Etiqueta de las láminas que el análisis no llegó a clasificar. */
export const SIN_CLASIFICAR = 'sin_clasificar';

export type ConteoDisciplina = { disciplina: Disciplina | typeof SIN_CLASIFICAR; cantidad: number };
export type ConteoTipo = { tipo: TipoLamina | typeof SIN_CLASIFICAR; cantidad: number };

export type RubroDelAlcance = {
  rubro: RubroId;
  nombre: string;
  items: number;
  /** Las primeras descripciones, ordenadas por clave: para leer de un vistazo. */
  ejemplos: string[];
};

export type LaminaTrabada = {
  laminaId: string;
  codigo: string | null;
  titulo: string | null;
  estado: EstadoAnalisis;
  motivo: string;
};

export type ConsultaDestacada = {
  clave: string;
  descripcion: string;
  bloqueante: boolean;
};

/**
 * Es un `type` y no una `interface` a propósito: `obras.resumen_json` está
 * tipada como `Record<string, unknown>` y TypeScript solo le da índice implícito
 * a los alias de tipo. Con una interface habría que castear en cada escritura.
 */
export type ResumenObra = {
  /** Una oración con lo esencial, para el encabezado de la pantalla. */
  titular: string;
  obra: { nombre: string; tipo: TipoObra; zona: string };
  laminas: {
    total: number;
    analizadas: number;
    bloqueadas: number;
    pendientes: number;
    conError: number;
    porDisciplina: ConteoDisciplina[];
    porTipo: ConteoTipo[];
  };
  alcance: RubroDelAlcance[];
  documentacion: {
    disciplinasPresentes: Disciplina[];
    /** Disciplinas del dominio sin ninguna lámina: el hueco del legajo. */
    disciplinasAusentes: Disciplina[];
    tiposPresentes: TipoLamina[];
    tiposAusentes: TipoLamina[];
    /** Láminas que no entran al cómputo y por qué. */
    trabadas: LaminaTrabada[];
  };
  consultas: {
    abiertas: number;
    bloqueantes: number;
    destacadas: ConsultaDestacada[];
  };
};

/** Lo que el resumen necesita saber de una lámina. */
export interface LaminaDelResumen {
  id: string;
  codigo: string | null;
  titulo: string | null;
  disciplina: Disciplina | null;
  tipo: TipoLamina | null;
  estadoAnalisis: EstadoAnalisis;
  errorDetalle: string | null;
}

/** Lo que el resumen necesita saber de una consulta de la bandeja. */
export interface HallazgoDelResumen {
  clave: string;
  descripcion: string;
  bloqueante: boolean;
  estado: 'abierto' | 'respondido' | 'descartado';
}

/** Cuántas consultas se listan enteras antes de pasar a contarlas. */
export const MAXIMO_CONSULTAS_DESTACADAS = 5;

/** Cuántos ítems de un rubro se nombran como ejemplo. */
export const MAXIMO_EJEMPLOS = 3;

// ---------------------------------------------------------------------------
// Núcleo puro
// ---------------------------------------------------------------------------

const ETIQUETA_TIPO_OBRA: Record<TipoObra, string> = {
  nueva: 'Obra nueva',
  reforma: 'Reforma',
  ampliacion: 'Ampliación',
};

/** "3 láminas", "1 lámina" — el plural se escribe, no se deja "1 lámina(s)". */
function plural(cantidad: number, singular: string, plural_: string): string {
  return `${cantidad} ${cantidad === 1 ? singular : plural_}`;
}

function contarPor<T extends string>(
  valores: readonly (T | null)[],
  orden: readonly T[],
): Array<{ valor: T | typeof SIN_CLASIFICAR; cantidad: number }> {
  const conteo = new Map<string, number>();
  for (const valor of valores) {
    const clave = valor ?? SIN_CLASIFICAR;
    conteo.set(clave, (conteo.get(clave) ?? 0) + 1);
  }

  const salida: Array<{ valor: T | typeof SIN_CLASIFICAR; cantidad: number }> = [];
  for (const valor of orden) {
    const cantidad = conteo.get(valor);
    if (cantidad !== undefined) salida.push({ valor, cantidad });
  }
  const sinClasificar = conteo.get(SIN_CLASIFICAR);
  if (sinClasificar !== undefined) salida.push({ valor: SIN_CLASIFICAR, cantidad: sinClasificar });
  return salida;
}

/** Por qué una lámina no está aportando al cómputo. */
function motivoDeTraba(lamina: LaminaDelResumen): string | null {
  switch (lamina.estadoAnalisis) {
    case 'bloqueada_escala':
      return 'Sin escala confiable: no se computa hasta que cargues la escala o una medida de referencia.';
    case 'error':
      return lamina.errorDetalle ?? 'El análisis falló y no se pudo leer la lámina.';
    case 'pendiente':
      return 'Todavía no se analizó.';
    case 'procesando':
      return 'Se está analizando.';
    case 'analizada':
      return null;
  }
}

function titularDe(
  obra: { tipo: TipoObra },
  totalLaminas: number,
  alcance: readonly RubroDelAlcance[],
  trabadas: number,
  consultasAbiertas: number,
): string {
  const partes = [
    `${ETIQUETA_TIPO_OBRA[obra.tipo]} con ${plural(totalLaminas, 'lámina', 'láminas')}`,
    alcance.length === 0
      ? 'sin cómputo todavía'
      : `${plural(alcance.length, 'rubro computado', 'rubros computados')} (${alcance
          .map((entrada) => entrada.nombre.toLowerCase())
          .join(', ')})`,
  ];
  if (trabadas > 0) {
    partes.push(`${plural(trabadas, 'lámina trabada', 'láminas trabadas')}`);
  }
  partes.push(
    consultasAbiertas === 0
      ? 'sin consultas abiertas'
      : `${plural(consultasAbiertas, 'consulta abierta', 'consultas abiertas')}`,
  );
  return `${partes.join('; ')}.`;
}

/**
 * Lo que el motor necesita para dar **los mismos ítems que la planilla**.
 *
 * Todo opcional: sin nada, el resumen computa como una obra sin deducciones y
 * sin datos de obra, que es lo que hacía antes de que existieran. El que la
 * llama de verdad (`persistirResumen`) los pasa siempre — si no, un rubro que
 * solo computa gracias a un dato de obra desaparece del resumen mientras la
 * planilla lo muestra bien, y el resumen deja de ser la foto de la obra.
 */
export interface ContextoResumen {
  camposDeducidos?: CamposDeducidos;
  datosObra?: DatosObraResueltos;
}

/**
 * El resumen ejecutivo de una obra a partir de su estado.
 *
 * `entidades` son las de la obra (con las deducciones validadas ya aplicadas si
 * las hay): el alcance sale de correr el motor de cómputo sobre ellas, que es
 * puro. No se lee `computo_items` para que la función no dependa de la base y se
 * pueda pinnear en un test sin PGlite.
 */
export function generarResumen(
  obra: Pick<Obra, 'nombre' | 'tipo' | 'zona'>,
  laminasObra: readonly LaminaDelResumen[],
  entidadesObra: readonly EntidadPersistida[],
  hallazgosObra: readonly HallazgoDelResumen[],
  contexto: ContextoResumen = {},
): ResumenObra {
  const porDisciplina = contarPor(
    laminasObra.map((lamina) => lamina.disciplina),
    DISCIPLINAS,
  ).map(({ valor, cantidad }) => ({ disciplina: valor, cantidad }));

  const porTipo = contarPor(
    laminasObra.map((lamina) => lamina.tipo),
    TIPOS_LAMINA,
  ).map(({ valor, cantidad }) => ({ tipo: valor, cantidad }));

  const presentesDisciplina = new Set(
    laminasObra.map((lamina) => lamina.disciplina).filter((d): d is Disciplina => d !== null),
  );
  const presentesTipo = new Set(
    laminasObra.map((lamina) => lamina.tipo).filter((t): t is TipoLamina => t !== null),
  );

  // Todo lo que el motor recibe acá tiene que ser lo MISMO que recibe en
  // `recomputarObra`: el alcance del resumen tiene que dar los mismos ítems que
  // la planilla. Las láminas por el tipo (aberturas cuenta distinto según de qué
  // lámina salió cada carpintería), el origen por campo y los datos de obra —un
  // rubro que solo computa por una altura de local declarada una vez tiene que
  // estar en los dos lados—.
  const { items } = computarObra(
    entidadesObra,
    obra.tipo,
    undefined,
    contexto.camposDeducidos,
    laminasObra,
    contexto.datosObra,
  );
  const ordenados = [...items].sort((a, b) => a.claveItem.localeCompare(b.claveItem, 'es-AR'));
  const alcance: RubroDelAlcance[] = RUBROS.map((rubro) => {
    const delRubro = ordenados.filter((item) => item.rubro === rubro);
    return {
      rubro,
      nombre: PLANTILLAS[rubro].nombre,
      items: delRubro.length,
      ejemplos: delRubro.slice(0, MAXIMO_EJEMPLOS).map((item) => item.descripcion),
    };
  }).filter((entrada) => entrada.items > 0);

  const trabadas: LaminaTrabada[] = laminasObra
    .map((lamina) => {
      const motivo = motivoDeTraba(lamina);
      return motivo === null
        ? null
        : {
            laminaId: lamina.id,
            codigo: lamina.codigo,
            titulo: lamina.titulo,
            estado: lamina.estadoAnalisis,
            motivo,
          };
    })
    .filter((trabada): trabada is LaminaTrabada => trabada !== null);

  const abiertas = hallazgosObra.filter((hallazgo) => hallazgo.estado === 'abierto');
  // Las bloqueantes primero: son las que frenan la aprobación de un rubro.
  const destacadas = [...abiertas]
    .sort((a, b) => {
      if (a.bloqueante !== b.bloqueante) return a.bloqueante ? -1 : 1;
      return a.clave.localeCompare(b.clave, 'es-AR');
    })
    .slice(0, MAXIMO_CONSULTAS_DESTACADAS)
    .map((hallazgo) => ({
      clave: hallazgo.clave,
      descripcion: hallazgo.descripcion,
      bloqueante: hallazgo.bloqueante,
    }));

  const contarEstado = (estado: EstadoAnalisis): number =>
    laminasObra.filter((lamina) => lamina.estadoAnalisis === estado).length;

  return {
    titular: titularDe(obra, laminasObra.length, alcance, trabadas.length, abiertas.length),
    obra: { nombre: obra.nombre, tipo: obra.tipo, zona: obra.zona },
    laminas: {
      total: laminasObra.length,
      analizadas: contarEstado('analizada'),
      bloqueadas: contarEstado('bloqueada_escala'),
      pendientes: contarEstado('pendiente') + contarEstado('procesando'),
      conError: contarEstado('error'),
      porDisciplina,
      porTipo,
    },
    alcance,
    documentacion: {
      disciplinasPresentes: DISCIPLINAS.filter((d) => presentesDisciplina.has(d)),
      disciplinasAusentes: DISCIPLINAS.filter((d) => !presentesDisciplina.has(d)),
      tiposPresentes: TIPOS_LAMINA.filter((t) => presentesTipo.has(t)),
      tiposAusentes: TIPOS_LAMINA.filter((t) => !presentesTipo.has(t)),
      trabadas,
    },
    consultas: {
      abiertas: abiertas.length,
      bloqueantes: abiertas.filter((hallazgo) => hallazgo.bloqueante).length,
      destacadas,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

/**
 * Recalcula el resumen de la obra y lo deja en `obras.resumen_json`.
 *
 * Idempotente y barata de repetir: si el resumen no cambió no escribe ni audita
 * (`igualJson`, no `JSON.stringify` — el jsonb vuelve de Postgres con las claves
 * reordenadas, ver `@/lib/pipeline/json`).
 *
 * Las entidades pasan por `aplicarDeduccionesValidadas` antes de computarse —y
 * el motor recibe además los datos de obra y el origen por campo—, por el mismo
 * motivo: el alcance que muestra el resumen tiene que ser el mismo que el de la
 * planilla. Es un invariante fácil de romper en silencio, porque el resumen no
 * lee `computo_items`: lo vuelve a computar.
 */
export async function persistirResumen(db: Db, obraId: string): Promise<ResumenObra> {
  const [obra] = await db.select().from(obras).where(eq(obras.id, obraId));
  if (!obra) throw new ObraInexistenteError(obraId);

  const [filasLaminas, filasEntidades, filasHallazgos, filasDeducciones, datos] = await Promise.all([
    db.select().from(laminas).where(eq(laminas.obraId, obraId)).orderBy(laminas.numeroPagina),
    db.select().from(entidades).where(eq(entidades.obraId, obraId)),
    db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId)).orderBy(hallazgos.clave),
    db.select().from(deducciones).where(eq(deducciones.obraId, obraId)),
    datosDeObra(db, obraId),
  ]);

  // Orden estable de las entidades: sin esto el resumen dependería del orden en
  // que Postgres devuelva las filas, y el pin del test sería una casualidad.
  const persistidas = filasEntidades
    .map(comoEntidadPersistida)
    .sort(
      (a, b) =>
        a.laminaId.localeCompare(b.laminaId) ||
        a.tipo.localeCompare(b.tipo) ||
        a.nombre.localeCompare(b.nombre, 'es-AR'),
    );
  const { entidades: conDeducciones, camposDeducidos } = aplicarDeduccionesValidadas(
    persistidas,
    filasDeducciones,
  );

  const resumen = generarResumen(
    obra,
    filasLaminas.map((lamina) => ({
      id: lamina.id,
      codigo: lamina.codigo,
      titulo: lamina.titulo,
      disciplina: lamina.disciplina,
      tipo: lamina.tipo,
      estadoAnalisis: lamina.estadoAnalisis,
      errorDetalle: lamina.errorDetalle,
    })),
    conDeducciones,
    filasHallazgos.map((hallazgo) => ({
      clave: hallazgo.clave,
      descripcion: hallazgo.descripcion,
      bloqueante: hallazgo.bloqueante,
      estado: hallazgo.estado,
    })),
    { camposDeducidos, datosObra: datos },
  );

  if (igualJson(obra.resumenJson, resumen)) return resumen;

  await db.update(obras).set({ resumenJson: resumen }).where(eq(obras.id, obraId));
  await registrarAuditoria({
    obraId,
    actorTipo: 'agente',
    actorNombre: ACTOR_PIPELINE,
    accion: 'resumen_generado',
    targetRef: `obras:${obraId}`,
    diff: {
      titular: resumen.titular,
      laminas: resumen.laminas.total,
      rubros: resumen.alcance.length,
      consultasAbiertas: resumen.consultas.abiertas,
    },
  });

  return resumen;
}

/** El resumen guardado, si la obra ya tiene uno. Lo usa la pantalla. */
export function leerResumen(obra: Pick<Obra, 'resumenJson'>): ResumenObra | null {
  return (obra.resumenJson as ResumenObra | null) ?? null;
}
