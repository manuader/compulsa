/**
 * La fase de cruce: lo que el expediente dice de sí mismo, escrito en la base.
 *
 * El provider del cruce (`src/lib/analysis/cruce-*.ts`) mira la obra entera
 * —compactada a texto, sin PDFs— y devuelve cinco listas: hechos que valen para
 * toda la obra, campos que una lámina completa de otra, elementos que son el
 * mismo, contradicciones y láminas que conviene releer. Nada de eso escribe
 * nada: **escribe esto**, y con las reglas del §5.4.
 *
 * ## Las cinco decisiones de esta fase
 *
 *  1. **El saneo corre acá.** `cruzar()` devuelve el crudo del modelo, con
 *     códigos de rótulo en vez de uuids; `sanearCruce()` los resuelve contra el
 *     expediente real y descarta lo que no resuelve. Un fixture no puede colar
 *     lo que el modelo no podría decir, y los descartes se cuentan por
 *     categoría en la auditoría de la corrida (RNF-7: si el cruce está tirando
 *     la mitad de lo que devuelve, hay que poder verlo).
 *  2. **Umbral 0,7 para escribir.** Un dato de obra o un campo completado con
 *     confianza `< UMBRAL_DEDUCCION` no entra: la regla de oro §11.b no tiene
 *     una excepción para el cruce. Lo omitido se cuenta en la auditoría.
 *  3. **Lo que decidió una persona no se pisa jamás.** Un `datos_obra` con
 *     `definido_por` es intocable; una deducción `validada` por un usuario o
 *     `rechazada` tampoco se toca. El cruce completa huecos, no corrige
 *     personas.
 *  4. **Aplicar dos veces el mismo cruce = cero diffs.** Todo es upsert con
 *     comparación previa (`igualJson`); las dos listas que se escriben por
 *     clave —datos de obra y campos completados— se deduplican antes de
 *     escribir, porque `sanearCruce` no deduplica a propósito; y las identidades
 *     reutilizan el `elemento_id` que ya exista en el grupo en vez de generar
 *     uno nuevo. Sin eso, cada corrida reescribía la obra entera y ahogaba
 *     `auditoria` en ruido.
 *  5. **Las contradicciones son avisos, no frenos.** Nacen como hallazgo
 *     `inconsistencia` **no bloqueante**, con una clave estable derivada de los
 *     dos datos y las dos láminas: el mismo conflicto redactado de otra manera
 *     no abre una consulta nueva. Su prefijo (`cruce.`) está protegido del
 *     conciliador del recompute (`claves.ts`), que si no las cerraría a los
 *     milisegundos de abrirlas — y por eso mismo **el cruce las concilia**: un
 *     cruce exitoso cierra las que ya no encuentra
 *     (`cerrarConflictosResueltos`), igual que hace la doble pasada con las
 *     suyas. Un cruce que se cayó no cierra nada.
 *
 * ## Lo que esta fase NO hace (v1, documentado a propósito)
 *
 * Un **dato de obra con confianza < 0,7 se descarta**, no se propone. Una
 * deducción `propuesta` necesita una entidad a la que apuntar (`deducciones`
 * tiene `entidad_id NOT NULL`) y un dato de obra no la tiene, así que hoy no
 * hay dónde dejarlo esperando revisión. Queda contado en la auditoría
 * (`datosOmitidos`) y el hueco sigue siendo una consulta honesta en la bandeja.
 *
 * Un **campo completado con confianza < 0,7** tampoco se escribe, y el motivo
 * es distinto: nacería `propuesta`, y `sincronizarDeducciones()` borra en cada
 * recompute toda propuesta que el motor de reglas ya no sostenga —el cruce no
 * es el motor—, así que la fila se insertaría y se borraría en cada corrida.
 * Un diff fantasma por lámina, para ofrecer algo que desaparece antes de que
 * nadie lo vea. Cuando exista un lugar donde una propuesta del cruce sobreviva
 * al recompute, este es el punto a cambiar.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '@/db/client';
import {
  datosObra,
  deducciones,
  entidades,
  hallazgos,
  laminas,
  type DatoObra,
  type Deduccion,
} from '@/db/schema';
import {
  sanearCruce,
  type CampoCompletado,
  type ConflictoCruce,
  type ContextoCruce,
  type CruceCrudo,
  type DatoObraCruzado,
  type EntidadDelCruce,
  type ResultadoCruce,
} from '@/lib/analysis/cruce-tipos';
import { registrarAuditoria } from '@/lib/audit';
import { UMBRAL_DEDUCCION } from '@/lib/deduccion/motor';
import { claveConflictoCruce, PREFIJO_CRUCE } from '@/lib/pipeline/claves';
import { canonicalizar, igualJson } from '@/lib/pipeline/json';
import { ACTOR_PIPELINE } from '@/lib/pipeline/recomputar';
import type { Fuente } from '@/types/domain';

/** La corrida completa del cruce, con sus números. */
export const ACCION_CRUCE = 'cruce_aplicado';

/** Un hecho de la obra que el cruce escribió por primera vez. */
export const ACCION_DATO_ESCRITO = 'dato_obra_escrito';

/** Un hecho de la obra que el cruce corrigió. */
export const ACCION_DATO_ACTUALIZADO = 'dato_obra_actualizado';

/**
 * Una deducción que nace **aplicada**: el sistema la dedujo y la usó en la
 * misma corrida (§5.4), sin que nadie la valide a mano. Se distingue de
 * `deduccion_validada`, que es la del arquitecto apretando el botón.
 */
export const ACCION_DEDUCCION_APLICADA = 'deduccion_aplicada';

/** Dos o más entidades que resultaron ser el mismo elemento físico (§15). */
export const ACCION_IDENTIDAD = 'entidades_unificadas';

/** El origen de un dato de obra que resolvió el cruce: se apoya en documentación. */
const ORIGEN_CRUCE = 'deducido' as const;

/**
 * Respuesta con la que un cruce posterior cierra una contradicción que ya no
 * encuentra. Hermana de `RESPUESTA_VERIFICADO` (`verificacion.ts`), y por el
 * mismo motivo: la consulta no se descarta porque alguien la ignore sino porque
 * el sistema volvió a mirar y el motivo dejó de existir.
 */
export const RESPUESTA_CRUCE_RESUELTO = {
  auto: 'el cruce volvió a leer el expediente y las dos láminas ya no se contradicen',
} as const;

/**
 * El namespace de las contradicciones, sin la huella:
 * `cruce.conflicto.` — se arma con la misma función que las claves, así que no
 * pueden separarse.
 */
const PREFIJO_CONFLICTO = claveConflictoCruce('');

// ---------------------------------------------------------------------------
// El expediente contra el que se resuelve lo que dijo el modelo
// ---------------------------------------------------------------------------

export interface ExpedienteDelCruce {
  /** Lo que `sanearCruce()` necesita para traducir códigos y nombres a ids. */
  ctx: ContextoCruce;
  /** `laminaId → cómo se la cita`: su código, o su id si no leyó ninguno. */
  refs: Map<string, string>;
}

/**
 * Lee de la base lo que hace falta para resolver lo que el modelo escribió.
 *
 * Dos láminas con el mismo código son un expediente mal rotulado, no un motivo
 * para fallar: gana la primera por número de página y la segunda queda
 * inalcanzable por código (el saneo la va a descartar si el modelo la cita, que
 * es lo honesto — no hay manera de saber a cuál se refería).
 */
export async function expedienteDelCruce(db: Db, obraId: string): Promise<ExpedienteDelCruce> {
  const [planos, elementos] = await Promise.all([
    db
      .select({ id: laminas.id, codigo: laminas.codigo })
      .from(laminas)
      .where(eq(laminas.obraId, obraId))
      .orderBy(laminas.numeroPagina),
    db
      .select({
        id: entidades.id,
        laminaId: entidades.laminaId,
        nombre: entidades.nombre,
        tipo: entidades.tipo,
      })
      .from(entidades)
      .where(eq(entidades.obraId, obraId)),
  ]);

  const laminasPorCodigo = new Map<string, string>();
  const refs = new Map<string, string>();
  for (const plano of planos) {
    refs.set(plano.id, plano.codigo ?? plano.id);
    if (plano.codigo !== null && !laminasPorCodigo.has(plano.codigo)) {
      laminasPorCodigo.set(plano.codigo, plano.id);
    }
  }

  const delCruce: EntidadDelCruce[] = elementos;
  return { ctx: { laminasPorCodigo, entidades: delCruce }, refs };
}

// ---------------------------------------------------------------------------
// Claves y textos
// ---------------------------------------------------------------------------

/**
 * La clave estable de una contradicción: los **dos datos** y las **dos
 * láminas**, sin la descripción.
 *
 * Que la redacción quede afuera es el punto: el modelo puede contar el mismo
 * conflicto con otras palabras en cada corrida, y si la clave dependiera del
 * texto, cada corrida abriría una consulta nueva sobre lo mismo y la anterior
 * quedaría abierta para siempre. Las láminas van ordenadas porque cuál se cita
 * primero no cambia cuál es la contradicción.
 *
 * Los **datos** sí van en orden, y no ordenados: son el par que el modelo leyó,
 * y la memoria compacta que lee es estable entre corridas, así que el orden
 * también lo es. Si algún día el mismo conflicto volviera con los datos
 * invertidos, se abriría una consulta más; preferimos eso a normalizar dos
 * lecturas distintas en una sola clave.
 */
export function claveConflicto(conflicto: ConflictoCruce): string {
  const huella = createHash('sha256')
    .update(
      JSON.stringify(
        canonicalizar({
          datoA: conflicto.datoA,
          datoB: conflicto.datoB,
          laminas: [conflicto.laminaIdA, conflicto.laminaIdB].sort(),
        }),
      ),
    )
    .digest('hex')
    .slice(0, 8);
  return claveConflictoCruce(huella);
}

/** El texto de la consulta: qué dice cada lámina, y la causa si el modelo la arriesgó. */
export function descripcionConflicto(
  conflicto: ConflictoCruce,
  refs: ReadonlyMap<string, string>,
): string {
  const refA = refs.get(conflicto.laminaIdA) ?? conflicto.laminaIdA;
  const refB = refs.get(conflicto.laminaIdB) ?? conflicto.laminaIdB;
  const causa = conflicto.causaPosible === undefined ? '' : ` Puede ser ${conflicto.causaPosible}.`;
  return `${conflicto.descripcion} ${refA} dice «${conflicto.datoA}» y ${refB} dice «${conflicto.datoB}».${causa}`;
}

/** La lámina entera como fuente: es lo que cita el cruce cuando no hay bbox. */
function laminaCompleta(laminaId: string): Fuente {
  return { laminaId, bbox: [0, 0, 1, 1], detalle: 'Lámina completa' };
}

// ---------------------------------------------------------------------------
// Deduplicación: `sanearCruce` no deduplica, y acá no queda otra
// ---------------------------------------------------------------------------

/**
 * Una entrada por clave, la de mayor confianza (empate ⇒ la primera).
 *
 * El saneo devuelve todo lo que el modelo dijo, a propósito: con cuál quedarse
 * es una decisión de quien escribe. Y quien escribe **tiene** que decidirla,
 * porque dos lecturas del mismo dato aplicadas en orden dejan la base en el
 * valor de la última y la auditoría con dos escrituras por corrida, para
 * siempre.
 */
function mejorPorClave<T extends { confianza: number }>(
  items: readonly T[],
  clave: (item: T) => string,
): T[] {
  const mejores = new Map<string, T>();
  for (const item of items) {
    const k = clave(item);
    const previo = mejores.get(k);
    if (previo === undefined || item.confianza > previo.confianza) mejores.set(k, item);
  }
  return [...mejores.values()];
}

// ---------------------------------------------------------------------------
// Resultado de la aplicación
// ---------------------------------------------------------------------------

export interface ResumenCruce {
  datosEscritos: number;
  datosActualizados: number;
  /** Datos de obra que no se escribieron: bajo umbral, o definidos por una persona. */
  datosOmitidos: number;
  camposCompletados: number;
  camposActualizados: number;
  /** Campos que no se escribieron: bajo umbral, o pisarían una decisión. */
  camposOmitidos: number;
  identidadesUnificadas: number;
  conflictosAbiertos: number;
  conflictosActualizados: number;
  /** Contradicciones que este cruce ya no encuentra y cerró solo. */
  conflictosCerrados: number;
  relecturas: number;
}

function resumenVacio(): ResumenCruce {
  return {
    datosEscritos: 0,
    datosActualizados: 0,
    datosOmitidos: 0,
    camposCompletados: 0,
    camposActualizados: 0,
    camposOmitidos: 0,
    identidadesUnificadas: 0,
    conflictosAbiertos: 0,
    conflictosActualizados: 0,
    conflictosCerrados: 0,
    relecturas: 0,
  };
}

// ---------------------------------------------------------------------------
// Entrada pública
// ---------------------------------------------------------------------------

/**
 * Sanea lo que devolvió el provider y lo aplica sobre la obra.
 *
 * Devuelve el resultado **saneado** además del resumen: la fase de relectura
 * necesita las láminas que el cruce pidió releer, y volver a sanear el crudo
 * para eso sería correr dos veces la misma traducción.
 */
export async function aplicarCruce(
  db: Db,
  obraId: string,
  crudo: CruceCrudo,
  expediente: ExpedienteDelCruce,
): Promise<{ resultado: ResultadoCruce; resumen: ResumenCruce }> {
  const resultado = sanearCruce(crudo, expediente.ctx);
  const resumen = resumenVacio();
  resumen.relecturas = resultado.relecturas.length;

  await aplicarDatosDeObra(db, obraId, resultado.datosObra, resumen);
  await aplicarCompletados(db, obraId, resultado.completados, resumen);
  await aplicarIdentidades(db, obraId, resultado.identidades, resumen);
  await aplicarConflictos(db, obraId, resultado.conflictos, expediente.refs, resumen);

  await auditar(obraId, ACCION_CRUCE, `obras:${obraId}`, {
    ...resumen,
    // Cuánto tiró el saneo, por categoría: un cruce que descarta la mitad de lo
    // que devuelve es un problema de prompt o de rótulos, y hay que poder verlo.
    descartados: resultado.descartados,
  });

  return { resultado, resumen };
}

// ---------------------------------------------------------------------------
// Datos de obra
// ---------------------------------------------------------------------------

async function aplicarDatosDeObra(
  db: Db,
  obraId: string,
  datos: readonly DatoObraCruzado[],
  resumen: ResumenCruce,
): Promise<void> {
  if (datos.length === 0) return;

  const previos = await db.select().from(datosObra).where(eq(datosObra.obraId, obraId));
  const porClave = new Map(previos.map((fila) => [fila.clave, fila]));

  for (const dato of mejorPorClave(datos, (d) => d.clave)) {
    // Regla de oro §11.b: por debajo del umbral no se escribe. Y no se propone:
    // un dato de obra no tiene entidad a la que apuntar (ver la cabecera).
    if (dato.confianza < UMBRAL_DEDUCCION) {
      resumen.datosOmitidos += 1;
      continue;
    }

    const previo = porClave.get(dato.clave);
    // La línea que el pipeline no cruza: lo que cargó o corrigió una persona.
    if (previo?.definidoPor != null) {
      resumen.datosOmitidos += 1;
      continue;
    }

    const valores = {
      obraId,
      clave: dato.clave,
      valorJson: { valor: dato.valor, ...(dato.unidad === undefined ? {} : { unidad: dato.unidad }) },
      origen: ORIGEN_CRUCE,
      fuentesJson: dato.fuentes,
      confianza: dato.confianza,
      metodo: null,
    };

    if (previo === undefined) {
      await db.insert(datosObra).values(valores);
      resumen.datosEscritos += 1;
      await auditar(obraId, ACCION_DATO_ESCRITO, `datos_obra:${dato.clave}`, {
        valor: dato.valor,
        origen: ORIGEN_CRUCE,
        confianza: dato.confianza,
        fuentes: dato.fuentes.map((fuente) => fuente.laminaId),
      });
      continue;
    }

    if (sinCambios(previo, valores)) continue;

    await db
      .update(datosObra)
      .set({ ...valores, updatedAt: new Date() })
      .where(eq(datosObra.id, previo.id));
    resumen.datosActualizados += 1;
    await auditar(obraId, ACCION_DATO_ACTUALIZADO, `datos_obra:${dato.clave}`, {
      valor: { antes: previo.valorJson.valor, despues: dato.valor },
      confianza: { antes: previo.confianza, despues: dato.confianza },
    });
  }
}

/** Nada cambió ⇒ ni `UPDATE` ni línea de auditoría (regla 4 de la cabecera). */
function sinCambios(
  previo: DatoObra,
  valores: { valorJson: DatoObra['valorJson']; fuentesJson: Fuente[]; confianza: number },
): boolean {
  return (
    igualJson(previo.valorJson, valores.valorJson) &&
    igualJson(previo.fuentesJson, valores.fuentesJson) &&
    previo.confianza === valores.confianza &&
    previo.origen === ORIGEN_CRUCE &&
    previo.metodo === null
  );
}

// ---------------------------------------------------------------------------
// Campos completados desde otra lámina
// ---------------------------------------------------------------------------

async function aplicarCompletados(
  db: Db,
  obraId: string,
  completados: readonly CampoCompletado[],
  resumen: ResumenCruce,
): Promise<void> {
  if (completados.length === 0) return;

  const previas = await db.select().from(deducciones).where(eq(deducciones.obraId, obraId));
  const porClave = new Map(previas.map((fila) => [`${fila.entidadId}::${fila.campo}`, fila]));

  for (const campo of mejorPorClave(completados, (c) => `${c.entidadId}::${c.campo}`)) {
    if (campo.confianza < UMBRAL_DEDUCCION) {
      resumen.camposOmitidos += 1;
      continue;
    }

    const previa = porClave.get(`${campo.entidadId}::${campo.campo}`);
    if (previa !== undefined && esDecidida(previa)) {
      resumen.camposOmitidos += 1;
      continue;
    }

    const valores = {
      obraId,
      entidadId: campo.entidadId,
      campo: campo.campo,
      regla: 'cruce' as const,
      fuentesJson: campo.fuentes,
      // `{ [campo]: valor }`: se mergea tal cual en `entidades.atributos_json`
      // (el contrato de la columna, `src/db/schema.ts`).
      valorJson: { [campo.campo]: campo.valor },
      confianza: campo.confianza,
      // §5.4: una deducción de cruce con confianza ≥ 0,7 nace **validada** y se
      // aplica en la misma corrida. `validado_por` en `null` dice quién la
      // validó: nadie, la validó la regla.
      estado: 'validada' as const,
      validadoPor: null,
    };

    if (previa === undefined) {
      await db.insert(deducciones).values(valores);
      resumen.camposCompletados += 1;
      await auditar(
        obraId,
        ACCION_DEDUCCION_APLICADA,
        `deducciones:${campo.entidadId}.${campo.campo}`,
        {
          regla: 'cruce',
          valor: campo.valor,
          confianza: campo.confianza,
          fuentes: campo.fuentes.map((fuente) => fuente.laminaId),
        },
      );
      continue;
    }

    const igual =
      previa.regla === 'cruce' &&
      previa.estado === 'validada' &&
      previa.confianza === campo.confianza &&
      igualJson(previa.valorJson, valores.valorJson) &&
      igualJson(previa.fuentesJson, valores.fuentesJson);
    if (igual) continue;

    await db.update(deducciones).set(valores).where(eq(deducciones.id, previa.id));
    resumen.camposActualizados += 1;
    await auditar(
      obraId,
      ACCION_DEDUCCION_APLICADA,
      `deducciones:${campo.entidadId}.${campo.campo}`,
      {
        regla: { antes: previa.regla, despues: 'cruce' },
        valor: { antes: previa.valorJson, despues: valores.valorJson },
        confianza: { antes: previa.confianza, despues: campo.confianza },
      },
    );
  }
}

/**
 * `true` si la fila la decidió una persona y el cruce no la puede tocar.
 *
 * Una `rechazada` es una decisión suya. Una `validada` **con** `validado_por`
 * también. Una `validada` sin `validado_por` la escribió el sistema (este mismo
 * cruce, o una medición gráfica), y esa sí se puede poner al día. Una
 * `propuesta` está esperando revisión: el cruce la reemplaza por su lectura, que
 * viene con fuente y por encima del umbral.
 */
function esDecidida(fila: Deduccion): boolean {
  if (fila.estado === 'rechazada') return true;
  return fila.estado === 'validada' && fila.validadoPor !== null;
}

// ---------------------------------------------------------------------------
// Identidades (§15)
// ---------------------------------------------------------------------------

async function aplicarIdentidades(
  db: Db,
  obraId: string,
  grupos: readonly string[][],
  resumen: ResumenCruce,
): Promise<void> {
  for (const grupo of grupos) {
    const filas = await db
      .select({ id: entidades.id, elementoId: entidades.elementoId })
      .from(entidades)
      .where(and(eq(entidades.obraId, obraId), inArray(entidades.id, grupo)));
    if (filas.length < 2) continue;

    // Reusar el `elemento_id` que ya exista es lo que hace idempotente esto:
    // generar uno nuevo en cada corrida reescribiría el grupo entero para
    // siempre. Con dos grupos previos distintos gana el menor, que es un
    // criterio arbitrario pero **estable** — lo que no se puede es que la
    // elección dependa del orden en que la base devolvió las filas.
    const previos = [...new Set(filas.map((fila) => fila.elementoId).filter(esTexto))].sort();
    const elementoId = previos[0] ?? randomUUID();

    const aTocar = filas.filter((fila) => fila.elementoId !== elementoId).map((fila) => fila.id);
    if (aTocar.length === 0) continue;

    await db.update(entidades).set({ elementoId }).where(inArray(entidades.id, aTocar));
    resumen.identidadesUnificadas += 1;
    await auditar(obraId, ACCION_IDENTIDAD, `entidades:${elementoId}`, {
      entidades: filas.map((fila) => fila.id).sort(),
      actualizadas: aTocar.sort(),
      elementoId,
      motivo: 'El cruce reconoció el mismo elemento físico dibujado en varias láminas.',
    });
  }
}

const esTexto = (valor: string | null): valor is string => valor !== null;

// ---------------------------------------------------------------------------
// Conflictos (§17)
// ---------------------------------------------------------------------------

async function aplicarConflictos(
  db: Db,
  obraId: string,
  conflictos: readonly ConflictoCruce[],
  refs: ReadonlyMap<string, string>,
  resumen: ResumenCruce,
): Promise<void> {
  const emitidas = new Set<string>();

  for (const conflicto of conflictos) {
    const clave = claveConflicto(conflicto);
    emitidas.add(clave);
    const campos = {
      tipo: 'inconsistencia' as const,
      rubro: null,
      checklistItem: null,
      descripcion: descripcionConflicto(conflicto, refs),
      // NO bloqueante: es un aviso de que dos láminas no coinciden, no un dato
      // que falte. Frenar la aprobación de un rubro por esto sería el problema
      // que el rediseño vino a sacar.
      bloqueante: false,
      laminasJson: [laminaCompleta(conflicto.laminaIdA), laminaCompleta(conflicto.laminaIdB)],
      targetRef: null,
      targetDato: null,
      valorPropuestoJson: null,
    };

    const [previo] = await db
      .select()
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.clave, clave)));

    if (previo === undefined) {
      await db.insert(hallazgos).values({ obraId, clave, ...campos });
      resumen.conflictosAbiertos += 1;
      await auditar(obraId, 'hallazgo_abierto', `hallazgos:${clave}`, {
        tipo: campos.tipo,
        bloqueante: campos.bloqueante,
        laminas: [conflicto.laminaIdA, conflicto.laminaIdB],
      });
      continue;
    }

    // Lo que el arquitecto cerró no se reabre (regla 3 de la bandeja).
    if (previo.estado !== 'abierto') continue;

    const igual =
      previo.descripcion === campos.descripcion &&
      igualJson(previo.laminasJson, campos.laminasJson) &&
      previo.tipo === campos.tipo &&
      previo.bloqueante === campos.bloqueante;
    if (igual) continue;

    await db.update(hallazgos).set(campos).where(eq(hallazgos.id, previo.id));
    resumen.conflictosActualizados += 1;
    await auditar(obraId, 'hallazgo_actualizado', `hallazgos:${clave}`, {
      descripcion: { antes: previo.descripcion, despues: campos.descripcion },
    });
  }

  await cerrarConflictosResueltos(db, obraId, emitidas, resumen);
}

/**
 * Cierra los conflictos abiertos que **este** cruce ya no encuentra.
 *
 * Es el conciliador que el prefijo protegido se debe: `esClaveDelMotor()` deja
 * las claves `cruce.*` afuera del recompute —si no, el recompute de la fase 5
 * cerraría el aviso milisegundos después de abrirlo— y a cambio el cruce tiene
 * que administrarlas, exactamente como `verificarComputo` administra las suyas.
 * Sin esto, una contradicción que el arquitecto arregló subiendo la revisión
 * buena se quedaba abierta para siempre, y la bandeja terminaba llena de avisos
 * de láminas que ya no dicen lo que decían.
 *
 * **Solo lo llama un cruce que salió bien**: `cruzarTolerante` corta antes si el
 * provider se cayó, y con razón — un timeout no significa que las
 * contradicciones se resolvieron. Sin esa condición, la primera caída del
 * modelo barrería la bandeja entera.
 */
async function cerrarConflictosResueltos(
  db: Db,
  obraId: string,
  emitidas: ReadonlySet<string>,
  resumen: ResumenCruce,
): Promise<void> {
  const abiertos = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.estado, 'abierto')));

  for (const fila of abiertos) {
    if (!fila.clave.startsWith(PREFIJO_CONFLICTO) || emitidas.has(fila.clave)) continue;

    await db
      .update(hallazgos)
      .set({ estado: 'descartado', respuestaJson: { ...RESPUESTA_CRUCE_RESUELTO } })
      .where(eq(hallazgos.id, fila.id));
    resumen.conflictosCerrados += 1;
    await auditar(obraId, 'hallazgo_descartado', `hallazgos:${fila.clave}`, {
      ...RESPUESTA_CRUCE_RESUELTO,
    });
  }
}

// ---------------------------------------------------------------------------

function auditar(
  obraId: string,
  accion: string,
  targetRef: string,
  diff: Record<string, unknown>,
): Promise<void> {
  return registrarAuditoria({
    obraId,
    actorTipo: 'agente',
    actorNombre: ACTOR_PIPELINE,
    accion,
    targetRef,
    diff,
  });
}
