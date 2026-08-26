/**
 * Núcleos de la bandeja de consultas: cómo se resuelve un hallazgo.
 *
 * ## Por qué esto NO vive en el archivo `'use server'`
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** que el
 * cliente puede invocar con el payload que quiera. Estas funciones mutan la
 * base y reciben `obraId` y `actor` como parámetros: expuestas como endpoint,
 * cualquiera podría responder o descartar consultas de una obra ajena
 * firmándolas con el actor que se le antoje. El aislamiento entre estudios
 * (RNF-4) se caería sin que ningún test lo notara.
 *
 * Así que la división es dura: acá viven los núcleos —sin sesión, con la obra
 * y el actor explícitos, testeables contra una base en memoria— y en
 * `src/app/obras/[obraId]/bandeja/actions.ts` viven **solo** los envoltorios
 * `*Action`, que sacan el actor de la sesión y la obra de `requireObra()`.
 * El `obraId` del payload nunca llega hasta acá sin pasar por ese guard.
 *
 * ## Las cinco reglas del módulo
 *
 * 1. **Responder es aportar el dato, no tapar la consulta.** Si el hallazgo
 *    apunta a un campo de una entidad (`target_ref`) y el arquitecto escribe un
 *    número, ese número entra a `entidades.atributos_json` y la obra se
 *    recalcula: los ítems que aparecen salen con origen `explicito` porque el
 *    dato lo puso una persona (RF-602).
 * 2. **P4 hasta el final.** Una respuesta que no es un número no se escribe en
 *    un campo que el motor lee como medida: queda como nota. Antes una consulta
 *    respondida "de palabra" que un atributo inventado.
 * 3. **El hallazgo se cierra ANTES del recompute.** `recomputarObra` cierra con
 *    respuesta automática todo hallazgo abierto que el motor ya no emite; si
 *    recalculáramos primero, la respuesta del arquitecto se perdería contra un
 *    `{ auto: 'resuelto por recomputo' }`. El orden es: entidad → hallazgo →
 *    recompute.
 * 4. **Aislamiento (RNF-4):** todo hallazgo se busca con `obra_id` en el
 *    `where`, y la entidad de su `target_ref` también. Un id de otra obra no
 *    existe.
 * 5. **Toda escritura se audita** con actor `usuario` y diff (CLAUDE.md §4):
 *    responder un faltante de medidas deja dos registros, el de la entidad y el
 *    del hallazgo.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { parsearCantidad } from '@/app/obras/[obraId]/computo/actions';
import { getDb, type Db } from '@/db/client';
import { entidades, hallazgos, laminas, type Hallazgo } from '@/db/schema';
import type { AnalysisProvider } from '@/lib/analysis/index';
import { registrarAuditoria } from '@/lib/audit';
import { PREFIJO_ESCALA } from '@/lib/pipeline/claves';
import { actualizarLamina } from '@/lib/pipeline/procesar';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { StorageAdapter } from '@/lib/storage/index';
import type { EstadoHallazgo } from '@/types/domain';

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoAccion = { ok: true } | { ok: false; error: string };
/** `respondidas`: las del lote que ya tenían respuesta y quedaron intactas. */
export type ResultadoLote =
  | { ok: true; descartados: number; respondidas: number }
  | { ok: false; error: string };

/** Quién resuelve la consulta. Los `*Action` lo sacan de la sesión. */
export interface ActorBandeja {
  usuarioId: string;
  email: string;
}

/**
 * Costura para el flujo de escala, que reprocesa la lámina y por eso necesita
 * storage y provider. Los tests inyectan un storage temporal; la app usa los
 * defaults del pipeline. Nunca viaja desde el cliente.
 */
export interface DepsBandeja {
  storage?: StorageAdapter;
  provider?: AnalysisProvider;
}

export interface EntradaRespuesta {
  obraId: string;
  hallazgoId: string;
  /** Lo que escribió el arquitecto: "2,05", "1:100". */
  valor?: string | number | null;
  nota?: string | null;
}

export interface EntradaHallazgo {
  obraId: string;
  hallazgoId: string;
  nota?: string | null;
}

export interface EntradaLote {
  obraId: string;
  hallazgoIds: string[];
  nota?: string | null;
}

// ---------------------------------------------------------------------------
// Validación (el server nunca confía en el payload)
// ---------------------------------------------------------------------------

/** Forma 8-4-4-4-12, igual criterio que `requireObraCore`: se chequea la forma. */
export const zUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Identificador inválido.');

const zNota = z
  .string()
  .trim()
  .max(500, 'La nota no puede pasar de 500 caracteres.')
  .nullish();

const zRespuesta = z.object({
  obraId: zUuid,
  hallazgoId: zUuid,
  valor: z.union([z.string().trim().max(60, 'El valor no puede pasar de 60 caracteres.'), z.number()]).nullish(),
  nota: zNota,
});

const zHallazgo = z.object({ obraId: zUuid, hallazgoId: zUuid, nota: zNota });

/** 200 consultas de una: más que eso no es una selección, es un error de la UI. */
const zLote = z.object({
  obraId: zUuid,
  hallazgoIds: z.array(zUuid).min(1, 'No seleccionaste ninguna consulta.').max(200),
  nota: zNota,
});

function primerError(error: z.ZodError, porDefecto: string): string {
  return error.issues[0]?.message ?? porDefecto;
}

// ---------------------------------------------------------------------------
// Piezas compartidas
// ---------------------------------------------------------------------------

const NO_ENCONTRADO = 'No encontré esa consulta en esta obra.';
const YA_RESUELTA = 'Esa consulta ya está resuelta. Refrescá la bandeja para ver cómo quedó.';

function cargarHallazgo(db: Db, obraId: string, hallazgoId: string): Promise<Hallazgo | undefined> {
  return db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.id, hallazgoId), eq(hallazgos.obraId, obraId)))
    .then((filas) => filas[0]);
}

function auditar(
  obraId: string,
  actor: ActorBandeja,
  accion: string,
  targetRef: string,
  diff: Record<string, unknown>,
): Promise<void> {
  return registrarAuditoria({
    obraId,
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion,
    targetRef,
    diff,
  });
}

/** Cierra el hallazgo con su respuesta y deja el rastro de quién lo cerró. */
async function cerrar(
  db: Db,
  hallazgo: Hallazgo,
  actor: ActorBandeja,
  estado: Extract<EstadoHallazgo, 'respondido' | 'descartado'>,
  respuesta: Record<string, unknown>,
): Promise<void> {
  await db
    .update(hallazgos)
    .set({ estado, respuestaJson: respuesta, resueltoPor: actor.usuarioId })
    .where(eq(hallazgos.id, hallazgo.id));

  await auditar(
    hallazgo.obraId,
    actor,
    estado === 'descartado' ? 'hallazgo_descartado' : 'hallazgo_respondido',
    `hallazgos:${hallazgo.clave}`,
    { estado: { antes: hallazgo.estado, despues: estado }, respuesta },
  );
}

/**
 * La entidad a la que apunta el `target_ref`, con la obra en el `where`.
 * Puede no existir: un reproceso borra las entidades que ya no están en la
 * lámina y el hallazgo queda apuntando a la nada.
 */
function entidadDelTarget(db: Db, obraId: string, entidadId: string) {
  return db
    .select()
    .from(entidades)
    .where(and(eq(entidades.id, entidadId), eq(entidades.obraId, obraId)))
    .then((filas) => filas[0]);
}

/** `escala.<laminaId>` → el id de la lámina; `null` si la clave es de otra familia. */
function laminaBloqueada(clave: string): string | null {
  if (!clave.startsWith(PREFIJO_ESCALA)) return null;
  const id = clave.slice(PREFIJO_ESCALA.length);
  return zUuid.safeParse(id).success ? id : null;
}

function conNota(base: Record<string, unknown>, nota: string | null | undefined): Record<string, unknown> {
  return nota ? { ...base, nota } : base;
}

// ---------------------------------------------------------------------------
// Núcleos
// ---------------------------------------------------------------------------

/**
 * Responde una consulta.
 *
 * Tres caminos, en este orden:
 *  - clave `escala.<laminaId>` ⇒ confirma la escala de la lámina y la reprocesa
 *    (RF-201); el `valor` es el texto de la escala, no un número.
 *  - `target_ref` + valor numérico ⇒ el número entra al atributo de la entidad
 *    y la obra se recalcula.
 *  - resto ⇒ la respuesta queda como nota, sin tocar ningún dato.
 */
export async function responderHallazgo(
  entrada: EntradaRespuesta,
  actor: ActorBandeja,
  deps: DepsBandeja = {},
): Promise<ResultadoAccion> {
  const parseo = zRespuesta.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer la respuesta.') };
  }
  const { obraId, hallazgoId, valor, nota } = parseo.data;

  const db = await getDb();
  const hallazgo = await cargarHallazgo(db, obraId, hallazgoId);
  if (!hallazgo) return { ok: false, error: NO_ENCONTRADO };
  if (hallazgo.estado !== 'abierto') return { ok: false, error: YA_RESUELTA };

  const texto = typeof valor === 'number' ? String(valor) : (valor ?? '').trim();
  const notaLimpia = nota && nota !== '' ? nota : null;

  const laminaId = laminaBloqueada(hallazgo.clave);
  if (laminaId !== null) {
    return responderEscala(db, hallazgo, laminaId, texto, notaLimpia, actor, deps);
  }

  if (texto === '' && notaLimpia === null) {
    return { ok: false, error: 'Escribí el valor o dejá una nota para responder la consulta.' };
  }

  const numero = texto === '' ? null : await parsearCantidad(texto);
  const target = hallazgo.targetRef;

  // Camino bueno: el dato entra a la entidad y el cómputo lo levanta.
  if (target && numero !== null) {
    const entidad = await entidadDelTarget(db, obraId, target.entidadId);
    if (entidad) {
      const antes = entidad.atributosJson[target.campo] ?? null;
      await db
        .update(entidades)
        .set({ atributosJson: { ...entidad.atributosJson, [target.campo]: numero } })
        .where(eq(entidades.id, entidad.id));
      await auditar(obraId, actor, 'entidad_actualizada', `entidades:${entidad.id}`, {
        [target.campo]: { antes, despues: numero },
      });

      await cerrar(
        db,
        hallazgo,
        actor,
        'respondido',
        conNota({ tipo: 'valor', campo: target.campo, valor: numero }, notaLimpia),
      );
      await recomputarObra(obraId, { db });
      return { ok: true };
    }
  }

  // Sin entidad que actualizar: la respuesta se guarda tal cual, sin inventar
  // un atributo a partir de texto libre (P4).
  const respuesta =
    numero !== null
      ? conNota({ tipo: 'valor', valor: numero }, notaLimpia)
      : { tipo: 'nota', nota: notaLimpia ?? texto };

  await cerrar(db, hallazgo, actor, 'respondido', respuesta);
  return { ok: true };
}

/**
 * RF-201: el arquitecto confirma la escala y la lámina se vuelve a analizar.
 * El hallazgo se cierra primero, así el `cerrarHallazgoEscala` del pipeline no
 * lo pisa con su respuesta automática.
 */
async function responderEscala(
  db: Db,
  hallazgo: Hallazgo,
  laminaId: string,
  texto: string,
  nota: string | null,
  actor: ActorBandeja,
  deps: DepsBandeja,
): Promise<ResultadoAccion> {
  const [lamina] = await db
    .select()
    .from(laminas)
    .where(and(eq(laminas.id, laminaId), eq(laminas.obraId, hallazgo.obraId)));
  if (!lamina) return { ok: false, error: 'La lámina de esta consulta ya no está en la obra.' };

  const escala = texto === '' ? undefined : texto;
  if (escala !== undefined && escala.length > 40) {
    return { ok: false, error: 'La escala no puede pasar de 40 caracteres.' };
  }

  await cerrar(
    db,
    hallazgo,
    actor,
    'respondido',
    conNota({ tipo: 'escala', ...(escala ? { valor: escala } : {}) }, nota),
  );
  await actualizarLamina(
    db,
    lamina.id,
    { ...(escala ? { escala } : {}), escalaConfiable: true },
    actor,
    deps,
  );
  return { ok: true };
}

/**
 * El elemento ya está construido: no es alcance de obra (§11, clase
 * `existente`). La entidad pasa a `estado_reforma = 'existente'` y el recompute
 * le saca los ítems.
 */
export async function marcarExistente(
  entrada: EntradaHallazgo,
  actor: ActorBandeja,
): Promise<ResultadoAccion> {
  const parseo = zHallazgo.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer la consulta.') };
  }
  const { obraId, hallazgoId } = parseo.data;

  const db = await getDb();
  const hallazgo = await cargarHallazgo(db, obraId, hallazgoId);
  if (!hallazgo) return { ok: false, error: NO_ENCONTRADO };
  if (hallazgo.estado !== 'abierto') return { ok: false, error: YA_RESUELTA };

  const target = hallazgo.targetRef;
  let recalcular = false;

  if (target) {
    const entidad = await entidadDelTarget(db, obraId, target.entidadId);
    if (entidad && entidad.estadoReforma !== 'existente') {
      await db
        .update(entidades)
        .set({ estadoReforma: 'existente' })
        .where(eq(entidades.id, entidad.id));
      await auditar(obraId, actor, 'entidad_actualizada', `entidades:${entidad.id}`, {
        estadoReforma: { antes: entidad.estadoReforma, despues: 'existente' },
      });
      recalcular = true;
    }
  }

  await cerrar(db, hallazgo, actor, 'respondido', { tipo: 'existente' });
  if (recalcular) await recomputarObra(obraId, { db });
  return { ok: true };
}

/**
 * El arquitecto da por bueno el supuesto con el que se computó. No cambia
 * ningún número: el ítem ya se emitió con origen `supuesto`.
 */
export async function confirmarSupuesto(
  entrada: EntradaHallazgo,
  actor: ActorBandeja,
): Promise<ResultadoAccion> {
  const parseo = zHallazgo.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer la consulta.') };
  }
  const { obraId, hallazgoId, nota } = parseo.data;

  const db = await getDb();
  const hallazgo = await cargarHallazgo(db, obraId, hallazgoId);
  if (!hallazgo) return { ok: false, error: NO_ENCONTRADO };
  if (hallazgo.estado !== 'abierto') return { ok: false, error: YA_RESUELTA };
  if (hallazgo.tipo !== 'supuesto') {
    return { ok: false, error: 'Esa consulta no es un supuesto: respondela o descartala.' };
  }

  await cerrar(
    db,
    hallazgo,
    actor,
    'respondido',
    conNota({ tipo: 'supuesto_confirmado' }, nota && nota !== '' ? nota : null),
  );
  return { ok: true };
}

/**
 * La consulta no aplica. No cambia datos: el gate del rubro la deja de contar.
 *
 * Solo se descarta desde `abierto`. Una consulta ya respondida no se descarta
 * "por arriba": `cerrar()` pisaría su `respuesta_json` y su `resuelto_por` con
 * el payload de descarte, y la respuesta que el arquitecto dejó registrada
 * —el dato que aportó, el supuesto que confirmó— se perdería. Volver a
 * descartar una descartada sí es un no-op idempotente.
 */
export async function descartarHallazgo(
  entrada: EntradaHallazgo,
  actor: ActorBandeja,
): Promise<ResultadoAccion> {
  const parseo = zHallazgo.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer la consulta.') };
  }
  const { obraId, hallazgoId, nota } = parseo.data;

  const db = await getDb();
  const hallazgo = await cargarHallazgo(db, obraId, hallazgoId);
  if (!hallazgo) return { ok: false, error: NO_ENCONTRADO };
  if (hallazgo.estado === 'descartado') return { ok: true }; // idempotente
  if (hallazgo.estado !== 'abierto') return { ok: false, error: YA_RESUELTA };

  await cerrar(
    db,
    hallazgo,
    actor,
    'descartado',
    conNota({ tipo: 'descartado' }, nota && nota !== '' ? nota : null),
  );
  return { ok: true };
}

/**
 * Descarta varias de una.
 *
 * Dos reglas de lote:
 *  - **O son todas de la obra o no se descarta ninguna:** un id ajeno en la
 *    lista es un error de la pantalla, no algo para ignorar en silencio.
 *  - **Las respondidas se saltean, no se pisan.** Un lote es una selección
 *    hecha sobre una pantalla que puede haber envejecido (otra pestaña, otro
 *    usuario): si una de las consultas se respondió mientras tanto, descartarla
 *    borraría esa respuesta. Se dejan como están y se informan aparte en
 *    `respondidas`, para que la pantalla pueda decir qué no se tocó. Las ya
 *    descartadas son un no-op idempotente y no se cuentan.
 */
export async function descartarLote(
  entrada: EntradaLote,
  actor: ActorBandeja,
): Promise<ResultadoLote> {
  const parseo = zLote.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer la selección.') };
  }
  const { obraId, hallazgoIds, nota } = parseo.data;
  const ids = [...new Set(hallazgoIds)];

  const db = await getDb();
  const filas = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), inArray(hallazgos.id, ids)));

  if (filas.length !== ids.length) {
    return { ok: false, error: 'Alguna de las consultas seleccionadas no es de esta obra.' };
  }

  const respuesta = conNota({ tipo: 'descartado' }, nota && nota !== '' ? nota : null);
  let descartados = 0;
  let respondidas = 0;
  for (const fila of filas) {
    if (fila.estado === 'descartado') continue;
    if (fila.estado !== 'abierto') {
      respondidas += 1;
      continue;
    }
    await cerrar(db, fila, actor, 'descartado', respuesta);
    descartados += 1;
  }

  return { ok: true, descartados, respondidas };
}
