/**
 * Núcleos de la bandeja de deducciones: validar o rechazar lo que propuso el
 * motor de §11.
 *
 * ## Por qué esto NO vive en el archivo `'use server'`
 *
 * Mismo motivo que `src/lib/bandeja/resolver.ts`: en un archivo `'use server'`
 * **todo export es un endpoint HTTP** que el cliente invoca con el payload que
 * quiera. Estas funciones escriben en `entidades` y en `deducciones` y reciben
 * la obra y el actor como parámetros: expuestas como endpoint, cualquiera
 * validaría deducciones de una obra ajena firmándolas con el rol que se le
 * antoje. Acá viven los núcleos —obra y actor explícitos, testeables contra una
 * base en memoria— y en `src/app/obras/[obraId]/deducciones/actions.ts` viven
 * **solo** los envoltorios `*Action`, que sacan el actor de la sesión y la obra
 * de `requireObra()`.
 *
 * ## Las cinco reglas del módulo
 *
 * 1. **Validar es escribir el dato, no aprobar una sugerencia.** El valor baja a
 *    `entidades.atributos_json` y las fuentes de la deducción se suman a la
 *    provenance de la entidad (P1: el dato y de dónde salió son la misma cosa).
 *    Recién ahí el recompute puede emitir el ítem, y lo emite con
 *    `origen: 'deducido'` — el ítem nunca finge que el dato estaba escrito.
 * 2. **Rechazar no escribe nada.** La deducción queda `rechazada` —el motor no
 *    la vuelve a proponer— y el hueco sigue siendo un hallazgo `faltante`
 *    abierto en la bandeja de consultas, que es donde tiene que estar (P4).
 * 3. **Un dato ya cargado no se pisa.** Si mientras la propuesta esperaba
 *    alguien respondió la consulta con otro número, validar no lo reemplaza:
 *    devuelve el conflicto y deja que una persona decida.
 * 4. **Aislamiento (RNF-4):** la deducción se busca siempre con `obra_id` en el
 *    `where`, y la entidad también. Una deducción de otra obra no existe, y da
 *    exactamente el mismo error que una inventada.
 * 5. **Rol y auditoría.** Validar o rechazar es de `colaborador` para arriba
 *    (RF-1201) y las dos escrituras dejan su fila en `auditoria` con diff.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, type Db } from '@/db/client';
import { deducciones, entidades, type Deduccion } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { unirFuentes } from '@/lib/computo/presentacion';
import { describirValor, enumerar, etiquetaCampo } from '@/lib/deduccion/motor';
import { TITULO_REGLA } from '@/lib/deduccion/memoria';
import {
  estaContradicha,
  recomputarObra,
  valorQueDocumenta,
} from '@/lib/pipeline/recomputar';
import type { Fuente, RolUsuario } from '@/types/domain';

/**
 * Las marcas de "superada por la documentación" las pone el recompute
 * (`src/lib/pipeline/recomputar.ts`, que es quien detecta el conflicto). Se
 * re-exportan acá para que la bandeja, la memoria y la planilla las lean del
 * mismo lugar del que leen todo lo demás sobre una deducción.
 */
export { estaContradicha, valorQueDocumenta };

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoAccion = { ok: true } | { ok: false; error: string };

/** Quién decide. Los `*Action` lo sacan de la sesión, nunca del payload. */
export interface ActorDeduccion {
  usuarioId: string;
  email: string;
  rol: RolUsuario;
}

export interface EntradaDeduccion {
  obraId: string;
  deduccionId: string;
}

// ---------------------------------------------------------------------------
// Roles (RF-1201)
// ---------------------------------------------------------------------------

/**
 * **Pendiente: unificar.** `src/lib/plataforma/roles.ts` ya existe con el guard
 * canónico (`requireAccion`); esta copia sigue acá por lo mismo que las otras
 * dos (`compulsa/flujo.ts`, `proveedores/gestion.ts`): migrar los llamados
 * cambia la clase del error que los `*Action` y los tests distinguen con
 * `instanceof`. La jerarquía y la semántica (lanza, no devuelve booleano) son
 * las mismas que usó P4 en `src/lib/proveedores/gestion.ts`, justamente para que
 * unificar sea mecánico.
 */
const JERARQUIA: Record<RolUsuario, number> = { lectura: 0, colaborador: 1, titular: 2 };

export class RolInsuficienteError extends Error {
  constructor(
    readonly rol: RolUsuario,
    readonly minimo: RolUsuario,
  ) {
    super(
      rol === 'lectura'
        ? 'Tu usuario es de solo lectura: no podés validar ni rechazar deducciones.'
        : 'Tu rol no alcanza para esta acción.',
    );
    this.name = 'RolInsuficienteError';
  }
}

export function requireRolCore(rol: RolUsuario, minimo: RolUsuario): void {
  if (JERARQUIA[rol] < JERARQUIA[minimo]) throw new RolInsuficienteError(rol, minimo);
}

// ---------------------------------------------------------------------------
// Validación del payload (el server nunca confía en el cliente)
// ---------------------------------------------------------------------------

const zUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Identificador inválido.');

const zEntrada = z.object({ obraId: zUuid, deduccionId: zUuid });

// ---------------------------------------------------------------------------
// Mensajes (uno solo para "no existe" y "no es tuya": no se filtra existencia)
// ---------------------------------------------------------------------------

export const NO_ENCONTRADA = 'No encontré esa deducción en esta obra.';
export const YA_DECIDIDA =
  'Esa deducción ya está resuelta. Refrescá la pantalla para ver cómo quedó.';
export const ENTIDAD_AUSENTE =
  'El elemento sobre el que hablaba esta deducción ya no está en la lámina.';

/** Un dato que ya cargó una persona vale más que uno deducido: no se pisa. */
export function conflictoDeValor(campo: string, cargado: unknown, propuesto: unknown): string {
  return (
    `${etiquetaCampo(campo)} ya está cargado con ${String(cargado)} y la deducción propone ` +
    `${String(propuesto)}. No lo piso: rechazá la deducción o corregí el dato a mano.`
  );
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** El valor que la deducción propone para su campo. */
export function valorDeDeduccion(fila: Pick<Deduccion, 'campo' | 'valorJson'>): number | string | null {
  const valor = fila.valorJson[fila.campo];
  return typeof valor === 'number' || typeof valor === 'string' ? valor : null;
}

/**
 * El "por qué" de una deducción, reconstruido desde lo que hay guardado.
 *
 * La tabla `deducciones` (P1) no tiene columna para la frase que arma el motor,
 * así que la bandeja y la memoria (RF-505) la vuelven a componer con lo que sí
 * está: la regla, el campo, el valor y las láminas que la sostienen. Dice lo
 * mismo con menos color; la trazabilidad —qué regla, qué láminas— está entera.
 *
 * Si la deducción quedó **superada por la documentación**, la frase lo dice al
 * final: es lo primero que hay que saber al leerla en la memoria, porque el
 * número de la fila ya no es el que se computa.
 */
export function explicarDeduccion(
  fila: Pick<Deduccion, 'campo' | 'regla' | 'valorJson' | 'fuentesJson'>,
  codigos: ReadonlyMap<string, string> = new Map(),
): string {
  const valor = valorDeDeduccion(fila);
  const sujeto = fila.fuentesJson[0]?.detalle;
  const dato =
    valor === null
      ? `El ${etiquetaCampo(fila.campo)}`
      : `El ${etiquetaCampo(fila.campo)} ${describirValor(fila.campo, valor)}`;
  const de = sujeto ? ` de ${sujeto}` : '';
  const citas = citarLaminas(fila.fuentesJson, codigos);
  const donde = citas.length === 1 ? `la lámina ${citas[0]}` : `las láminas ${enumerar(citas)}`;

  const base = `${dato}${de} sale de la regla «${TITULO_REGLA[fila.regla]}», cruzando ${donde}.`;
  return estaContradicha(fila) ? `${base} ${frase(fila)}` : base;
}

/** "Superada por la documentación, que ahora dice 2,40 m: se computa con eso." */
function frase(fila: Pick<Deduccion, 'campo' | 'valorJson'>): string {
  const documentado = valorQueDocumenta(fila);
  const escrito =
    documentado === null || typeof documentado === 'boolean'
      ? String(documentado)
      : describirValor(fila.campo, documentado);
  return `Superada por la documentación, que ahora dice ${escrito}: se computa con eso.`;
}

/** Códigos de las láminas citadas, sin repetir y en el orden en que aparecen. */
export function citarLaminas(
  fuentes: readonly Fuente[],
  codigos: ReadonlyMap<string, string>,
): string[] {
  const citas = fuentes.map((fuente) => codigos.get(fuente.laminaId) ?? fuente.laminaId);
  return [...new Set(citas)];
}

// ---------------------------------------------------------------------------
// Piezas compartidas
// ---------------------------------------------------------------------------

function cargarDeduccion(db: Db, obraId: string, id: string): Promise<Deduccion | undefined> {
  return db
    .select()
    .from(deducciones)
    .where(and(eq(deducciones.id, id), eq(deducciones.obraId, obraId)))
    .then((filas) => filas[0]);
}

function auditar(
  obraId: string,
  actor: ActorDeduccion,
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

/** Los tres pasos que comparten validar y rechazar, antes de decidir nada. */
async function preparar(
  entrada: EntradaDeduccion,
  actor: ActorDeduccion,
): Promise<{ db: Db; deduccion: Deduccion } | { error: string }> {
  const parseo = zEntrada.safeParse(entrada);
  if (!parseo.success) {
    return { error: parseo.error.issues[0]?.message ?? 'No pude leer la deducción.' };
  }

  try {
    requireRolCore(actor.rol, 'colaborador');
  } catch (error) {
    if (error instanceof RolInsuficienteError) return { error: error.message };
    throw error;
  }

  const db = await getDb();
  const deduccion = await cargarDeduccion(db, parseo.data.obraId, parseo.data.deduccionId);
  if (!deduccion) return { error: NO_ENCONTRADA };
  if (deduccion.estado !== 'propuesta') return { error: YA_DECIDIDA };
  return { db, deduccion };
}

// ---------------------------------------------------------------------------
// Núcleos
// ---------------------------------------------------------------------------

/**
 * Valida una deducción: el dato baja a la entidad y la obra se recalcula.
 *
 * El orden es entidad → deducción → recompute, y no es casual: el recompute lee
 * las dos tablas, así que tiene que encontrarlas ya coherentes (la entidad con
 * el dato, la deducción en `validada`). Al revés, el ítem saldría con
 * `origen: 'explicito'` en la primera pasada.
 */
export async function validarDeduccion(
  entrada: EntradaDeduccion,
  actor: ActorDeduccion,
): Promise<ResultadoAccion> {
  const previo = await preparar(entrada, actor);
  if ('error' in previo) return { ok: false, error: previo.error };
  const { db, deduccion } = previo;

  const valor = valorDeDeduccion(deduccion);
  if (valor === null) {
    return { ok: false, error: 'Esa deducción no tiene un valor que pueda escribir.' };
  }

  const [entidad] = await db
    .select()
    .from(entidades)
    .where(and(eq(entidades.id, deduccion.entidadId), eq(entidades.obraId, deduccion.obraId)));
  if (!entidad) return { ok: false, error: ENTIDAD_AUSENTE };

  // Regla 3: lo que ya cargó una persona no se reemplaza por una deducción.
  const cargado = entidad.atributosJson[deduccion.campo];
  if (cargado !== undefined && cargado !== null && cargado !== '' && cargado !== valor) {
    return { ok: false, error: conflictoDeValor(deduccion.campo, cargado, valor) };
  }

  // P1: el dato y su provenance viajan juntos. Las fuentes de la deducción se
  // suman a las de la entidad —sin duplicar lámina+bbox— así el visor puede
  // mostrar de dónde salió el número aunque la entidad se dibuje en otra lámina.
  const fuentes = unirFuentes(entidad.fuentesJson, deduccion.fuentesJson);
  const sumadas = fuentes.length - entidad.fuentesJson.length;

  await db
    .update(entidades)
    .set({
      atributosJson: { ...entidad.atributosJson, [deduccion.campo]: valor },
      fuentesJson: fuentes,
    })
    .where(eq(entidades.id, entidad.id));

  await auditar(deduccion.obraId, actor, 'entidad_actualizada', `entidades:${entidad.id}`, {
    [deduccion.campo]: { antes: cargado ?? null, despues: valor },
    fuentesAgregadas: sumadas,
    via: 'deduccion',
    regla: deduccion.regla,
  });

  await db
    .update(deducciones)
    .set({ estado: 'validada', validadoPor: actor.usuarioId })
    .where(eq(deducciones.id, deduccion.id));

  await auditar(
    deduccion.obraId,
    actor,
    'deduccion_validada',
    `deducciones:${deduccion.entidadId}.${deduccion.campo}`,
    {
      estado: { antes: 'propuesta', despues: 'validada' },
      regla: deduccion.regla,
      valor,
      confianza: deduccion.confianza,
    },
  );

  await recomputarObra(deduccion.obraId, { db });
  return { ok: true };
}

/**
 * Rechaza una deducción. No toca la entidad: el dato sigue faltando y su
 * consulta `faltante` sigue abierta en la bandeja, que es exactamente lo que el
 * PRD pide (§11: rechazar ⇒ hallazgo faltante normal).
 *
 * El recompute igual corre: la deducción rechazada deja de proponerse y la
 * pantalla tiene que quedar consistente sin depender de la próxima lámina.
 */
export async function rechazarDeduccion(
  entrada: EntradaDeduccion,
  actor: ActorDeduccion,
): Promise<ResultadoAccion> {
  const previo = await preparar(entrada, actor);
  if ('error' in previo) return { ok: false, error: previo.error };
  const { db, deduccion } = previo;

  await db
    .update(deducciones)
    .set({ estado: 'rechazada', validadoPor: actor.usuarioId })
    .where(eq(deducciones.id, deduccion.id));

  await auditar(
    deduccion.obraId,
    actor,
    'deduccion_rechazada',
    `deducciones:${deduccion.entidadId}.${deduccion.campo}`,
    {
      estado: { antes: 'propuesta', despues: 'rechazada' },
      regla: deduccion.regla,
      valor: valorDeDeduccion(deduccion),
    },
  );

  await recomputarObra(deduccion.obraId, { db });
  return { ok: true };
}
