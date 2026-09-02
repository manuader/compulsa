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
 *    apunta a campos de una entidad (`target_ref`) y el arquitecto escribe los
 *    números, esos números entran a `entidades.atributos_json` y la obra se
 *    recalcula: los ítems que aparecen salen con origen `explicito` porque el
 *    dato lo puso una persona (RF-602). Los campos van **todos juntos**: una
 *    carpintería sin acotar pide ancho y alto en la misma tarjeta, se escriben
 *    en un solo `update`, se auditan en un solo registro y disparan un solo
 *    recompute. Responder de a un campo hacía reaparecer la consulta por el
 *    otro.
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
 *
 * ## Confirmar una propuesta
 *
 * Desde "proponer en vez de bloquear" una consulta puede venir con un
 * `valor_propuesto_json`: lo que el sistema leyó (con poca confianza, del
 * rótulo o de una búsqueda dirigida) y ofrece para confirmar. Confirmar es
 * responder con esos valores —el mismo camino, la misma auditoría—, y por eso
 * `confirmarLote` no es un modo aparte: es el lote de "respondé con lo que ya
 * proponías".
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { parsearCantidad } from '@/app/obras/[obraId]/computo/actions';
import { getDb, type Db } from '@/db/client';
import { datosObra, entidades, hallazgos, laminas, type Hallazgo } from '@/db/schema';
import { esCampoDeMedida } from '@/lib/analysis/busqueda-tipos';
import type { AnalysisProvider } from '@/lib/analysis/index';
import { registrarAuditoria } from '@/lib/audit';
import { enumerar, etiquetaCampo } from '@/lib/deduccion/motor';
import { camposDelTarget } from '@/lib/hallazgos/target';
import { CAMPO_DATO_OBRA } from '@/lib/hallazgos/taxonomia';
import { PREFIJO_ESCALA } from '@/lib/pipeline/claves';
import { actualizarLamina } from '@/lib/pipeline/procesar';
import { recomputarObra } from '@/lib/pipeline/recomputar';
import type { StorageAdapter } from '@/lib/storage/index';
import type { EstadoHallazgo, TargetDato } from '@/types/domain';

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoAccion = { ok: true } | { ok: false; error: string };
/** `respondidas`: las del lote que ya tenían respuesta y quedaron intactas. */
export type ResultadoLote =
  | { ok: true; descartados: number; respondidas: number }
  | { ok: false; error: string };

/**
 * `salteadas`: las del lote que no se podían confirmar —sin propuesta, ya
 * resueltas, sin entidad a la que escribirles—. No es un error: la selección se
 * hace sobre una pantalla y la bandeja mezcla consultas con propuesta y sin
 * ella.
 */
export type ResultadoConfirmacionLote =
  | { ok: true; confirmadas: number; salteadas: number }
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
  /**
   * Un valor por campo del `target_ref` (`{ anchoM: '0,90', altoM: '2,05' }`):
   * lo que manda la tarjeta cuando la consulta pide más de un dato. Las claves
   * se validan contra `camposDelTarget()`; los valores vacíos se ignoran.
   */
  valores?: Record<string, string | number> | null;
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

const zValorDeCampo = z.union([
  z.string().trim().max(60, 'El valor no puede pasar de 60 caracteres.'),
  z.number(),
]);

const zRespuesta = z.object({
  obraId: zUuid,
  hallazgoId: zUuid,
  valor: zValorDeCampo.nullish(),
  // Las claves las valida `camposDelTarget()` contra el hallazgo, no el schema:
  // acá solo se acota la forma de lo que llega del cliente.
  valores: z.record(z.string().max(60), zValorDeCampo).nullish(),
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

/** Responder "0" a un faltante dimensional cierra la consulta sin resolverla. */
export const MEDIDA_NO_POSITIVA = 'La medida tiene que ser mayor a cero.';

/**
 * Lo que se escribió en un campo de medida y no es una medida.
 *
 * **Cita textualmente lo que el arquitecto tipeó**, porque los tres casos que
 * caen acá se arreglan mirándolo: el typo (`2,o5` con o en vez de cero), la
 * unidad de más (`0,90 m` — el número va pelado, la unidad la pone el campo) y
 * el negativo (`-2`). Un "no pude leer el valor" a secas lo obliga a adivinar
 * cuál de los tres fue.
 */
function noEsUnaMedida(texto: string): string {
  return `«${texto}» no es una medida: escribí solo el número, con coma decimal y sin unidad.`;
}

/** Decisión 7: cerrar el supuesto de escala no marca la lámina como confiable. */
export const ESCALA_NO_ES_SUPUESTO =
  'La escala se confirma con el botón «Confirmar escala».';

/** Una clave que el hallazgo no pide es un error de la pantalla, no un dato. */
function campoDesconocido(campo: string): string {
  return `Esta consulta no pide «${campo}»: refrescá la bandeja y volvé a intentar.`;
}

/**
 * Responder de a medias cierra la consulta para siempre.
 *
 * `recomputarObra` no reabre un hallazgo cerrado (regla 3): si la respuesta
 * trae el ancho y no el alto, el ancho entra, la consulta queda `respondido` y
 * **el alto no se vuelve a pedir nunca** — sin ítem, sin consulta y sin nada
 * en la auditoría que diga que quedó algo sin cargar. Es el mismo agujero que
 * el "0", con otra cara: el campo que no viene en el payload y el que viene en
 * cero terminan igual. Se responde con todo o no se responde.
 */
function faltanCampos(faltantes: readonly string[]): string {
  const nombres = enumerar(faltantes.map((campo) => etiquetaCampo(campo)));
  return faltantes.length === 1
    ? `Falta ${nombres}: la consulta se responde con todas las medidas juntas, si no queda cerrada con el dato a medias.`
    : `Faltan ${nombres}: la consulta se responde con todas las medidas juntas, si no queda cerrada con el dato a medias.`;
}

/** Los campos que el hallazgo pide y la respuesta no trae, en el orden pedido. */
function camposSinResponder(
  pedidos: readonly string[],
  respondidos: Readonly<Record<string, unknown>>,
): string[] {
  return pedidos.filter((campo) => !(campo in respondidos));
}

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

/**
 * `escala.<laminaId>` → el id de la lámina; `null` si la clave es de otra
 * familia.
 *
 * Las claves de escala pueden llevar un sufijo (`escala.<laminaId>.rotulo`, el
 * aviso de que la relectura del rótulo contradice la escala confirmada), así
 * que se lee el **primer segmento** después del prefijo: la lámina es la misma
 * y la respuesta también —confirmar una escala, cualquiera de las dos.
 */
function laminaBloqueada(clave: string): string | null {
  if (!clave.startsWith(PREFIJO_ESCALA)) return null;
  const id = clave.slice(PREFIJO_ESCALA.length).split('.')[0] ?? '';
  return zUuid.safeParse(id).success ? id : null;
}

function conNota(base: Record<string, unknown>, nota: string | null | undefined): Record<string, unknown> {
  return nota ? { ...base, nota } : base;
}

/**
 * La respuesta que se guarda en `respuesta_json`.
 *
 * Con **un** campo conserva el shape de siempre (`{ tipo, campo, valor }`): es
 * lo que lee la bandeja para mostrar «Alto (m): 2,05» y lo que ya está escrito
 * en las filas viejas. Con más de uno no hay UN campo que nombrar y va el mapa
 * completo.
 */
function respuestaDeValores(valores: Record<string, number>): Record<string, unknown> {
  const campos = Object.keys(valores);
  const unico = campos[0];
  return campos.length === 1 && unico !== undefined
    ? { tipo: 'valor', campo: unico, valor: valores[unico] }
    : { tipo: 'valor', valores };
}

/**
 * **Decisión 4.** Confirmar un `*.baja_confianza.*` sube la confianza de la
 * entidad a 1.
 *
 * Sin esto, confirmar la propuesta no sirve para nada: el gate de
 * `computarRubro` mira la confianza de la **entidad**, así que el ítem se
 * seguiría degradando a consulta por más que los valores estén escritos y la
 * consulta cerrada — el dato quedaría cargado y el rubro igual de trabado. Al
 * confirmar, una persona se hace cargo de la lectura: eso es confianza 1.
 */
function confirmarSubeLaConfianza(hallazgo: Hallazgo): boolean {
  return hallazgo.checklistItem?.endsWith('.baja_confianza') ?? false;
}

/**
 * Escribe **todos** los campos de una vez: un `update` de `atributos_json`, un
 * registro de auditoría con todos los diffs. Escribirlos de a uno dejaba N
 * auditorías por una sola respuesta y N recomputes por una sola tarjeta.
 *
 * `false` si la entidad ya no está —un reproceso borra las entidades que la
 * lámina ya no tiene— y entonces el hallazgo se cierra sin tocar datos.
 */
async function escribirEnEntidad(
  db: Db,
  obraId: string,
  hallazgo: Hallazgo,
  valores: Record<string, number>,
  actor: ActorBandeja,
): Promise<boolean> {
  const target = hallazgo.targetRef;
  if (!target) return false;

  const entidad = await entidadDelTarget(db, obraId, target.entidadId);
  if (!entidad) return false;

  const atributos = { ...entidad.atributosJson };
  const diff: Record<string, unknown> = {};
  for (const [campo, numero] of Object.entries(valores)) {
    diff[campo] = { antes: entidad.atributosJson[campo] ?? null, despues: numero };
    atributos[campo] = numero;
  }

  const sube = confirmarSubeLaConfianza(hallazgo) && entidad.confianza < 1;
  if (sube) diff.confianza = { antes: entidad.confianza, despues: 1 };

  await db
    .update(entidades)
    .set({ atributosJson: atributos, ...(sube ? { confianza: 1 } : {}) })
    .where(eq(entidades.id, entidad.id));
  await auditar(obraId, actor, 'entidad_actualizada', `entidades:${entidad.id}`, diff);
  return true;
}

/** Las tres cosas que puede ser lo que se escribió en los inputs. */
type LecturaDeCampos =
  /** Todo número positivo: entra a la entidad. */
  | { tipo: 'numeros'; valores: Record<string, number> }
  /** Algo que no es un número: queda como nota, no como atributo (P4). */
  | { tipo: 'texto'; texto: string }
  /** Un número que no sirve como medida: no se escribe nada. */
  | { tipo: 'error'; error: string };

/**
 * Qué escribió el arquitecto en los campos de la consulta.
 *
 * Un "0" o un negativo **frenan todo**: `leerMedida()` solo toma positivos, así
 * que el motor seguiría sin poder computar, pero la consulta quedaría cerrada y
 * el rubro aprobable con el dato faltando — justo lo que el gate existe para
 * impedir (RF-404). Y frenan aunque los demás campos estén bien: escribir el
 * ancho y dejar el alto en cero deja la abertura igual de incomputable.
 *
 * **Un campo que no viene en el payload termina igual que uno en cero**, y por
 * eso se chequea aparte (`camposSinResponder`): la consulta se cerraría con la
 * mitad del dato y `recomputarObra` no la reabre. Acá se miran los valores que
 * llegaron; que estén todos es responsabilidad de quien llama.
 *
 * ## Por qué `pideMedidas`, y no "lo que no es número va a nota"
 *
 * Que un texto se guarde como nota es correcto **cuando la consulta pregunta
 * por un texto**: el `tipo` de un tabique se responde "durlock" y eso no es un
 * atributo numérico que inventarle a la entidad (P4).
 *
 * Sobre una consulta que pide **medidas** era el mismo agujero del "0" con otra
 * cara, y peor tapado. `parsearCantidad` devuelve `null` para todo lo que no es
 * un positivo —el negativo incluido, así que el `numero <= 0` de acá abajo solo
 * llegaba a atrapar el cero—, y con eso `-2`, `0,90 m` (con la unidad tipeada)
 * y el typo `2,o5` caían al camino de texto: la respuesta entera se cerraba
 * como `{tipo:'nota'}`, sin escribir un dato, sin recompute, y `recomputarObra`
 * no reabre (regla 3). Quedaba una abertura incomputable, un rubro aprobable y,
 * como única señal, una nota en «Respondidas». Es el mismo CRITICAL que ya se
 * tapó en los cierres parciales.
 *
 * Por eso: **si el target tiene aunque sea un campo de medida, un valor que no
 * es una medida es un error y la consulta queda abierta**, con el texto citado
 * para que se vea qué arreglar. El downgrade a nota queda solo para las
 * consultas donde ningún campo es de medida, que son las que se contestan en
 * palabras.
 */
async function leerCampos(
  crudos: readonly (readonly [string, string])[],
  pideMedidas: boolean,
): Promise<LecturaDeCampos> {
  const valores: Record<string, number> = {};
  for (const [campo, texto] of crudos) {
    const numero = await parsearCantidad(texto);
    if (numero === null) {
      if (pideMedidas) return { tipo: 'error', error: noEsUnaMedida(texto) };
      return { tipo: 'texto', texto: crudos.map(([, t]) => t).join(' · ') };
    }
    if (numero <= 0) return { tipo: 'error', error: MEDIDA_NO_POSITIVA };
    valores[campo] = numero;
  }
  return { tipo: 'numeros', valores };
}

/** `[campo, texto]` de los campos con algo escrito, en el orden que llegaron. */
function camposEscritos(
  valores: Record<string, string | number> | null | undefined,
): (readonly [string, string])[] {
  if (!valores) return [];
  const escritos: (readonly [string, string])[] = [];
  for (const [campo, valor] of Object.entries(valores)) {
    const texto = typeof valor === 'number' ? String(valor) : valor.trim();
    if (texto !== '') escritos.push([campo, texto] as const);
  }
  return escritos;
}

// ---------------------------------------------------------------------------
// Núcleos
// ---------------------------------------------------------------------------

/**
 * Responde una consulta.
 *
 * Cuatro caminos, en este orden:
 *  - clave `escala.<laminaId>` ⇒ confirma la escala de la lámina y la reprocesa
 *    (RF-201); el `valor` es el texto de la escala, no un número.
 *  - `valores` ⇒ todos los campos que pide el `target_ref` de una: un update,
 *    una auditoría, un recompute.
 *  - `valor` suelto ⇒ el primer campo del target (lo de siempre).
 *  - resto ⇒ la respuesta queda como nota, sin tocar ningún dato.
 *
 * La nota es el piso **solo si la consulta no pide medidas**. Sobre una que sí
 * las pide, un valor que no es una medida (`-2`, `0,90 m`, `2,o5`) es un error
 * y la consulta queda abierta: cerrarla como nota dejaba la abertura sin
 * computar y el rubro aprobable, y `recomputarObra` no reabre (regla 3).
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
  const { obraId, hallazgoId, valor, valores, nota } = parseo.data;

  const db = await getDb();
  const hallazgo = await cargarHallazgo(db, obraId, hallazgoId);
  if (!hallazgo) return { ok: false, error: NO_ENCONTRADO };
  if (hallazgo.estado !== 'abierto') return { ok: false, error: YA_RESUELTA };

  const texto = typeof valor === 'number' ? String(valor) : (valor ?? '').trim();
  const notaLimpia = nota && nota !== '' ? nota : null;

  const laminaId = laminaBloqueada(hallazgo.clave);
  if (laminaId !== null) {
    // La escala no es un campo de ninguna entidad: se confirma con su propio
    // texto, venga como `valor` o como la propuesta del rótulo en `valores`.
    const escala = texto !== '' ? texto : (camposEscritos(valores)[0]?.[1] ?? '');
    return responderEscala(db, hallazgo, laminaId, escala, notaLimpia, actor, deps);
  }

  // La otra cosa a la que puede apuntar una consulta: un hecho de la obra
  // entera (§5.2). No se escribe en ninguna entidad —el dato no es de ninguna—
  // y el recompute lo propaga a las N que lo estaban esperando.
  const dato = hallazgo.targetDato;
  if (dato) {
    if (valores) {
      for (const campo of Object.keys(valores)) {
        if (campo !== CAMPO_DATO_OBRA) return { ok: false, error: campoDesconocido(campo) };
      }
    }
    const propuesto = camposEscritos(valores)[0]?.[1] ?? '';
    return responderDatoObra(db, hallazgo, dato, texto !== '' ? texto : propuesto, notaLimpia, actor);
  }

  // `camposDelTarget()` es el único lector válido del `target_ref`: las filas
  // viejas guardaron `campo` singular y las nuevas guardan `campos`.
  const target = hallazgo.targetRef;
  const campos = camposDelTarget(target);

  // Una clave que esta consulta no pide no se escribe "por las dudas": sería
  // inventarle un atributo a la entidad desde el payload de otra pantalla.
  if (valores) {
    const pedidos = new Set(campos);
    for (const campo of Object.keys(valores)) {
      if (!pedidos.has(campo)) return { ok: false, error: campoDesconocido(campo) };
    }
  }

  const escritos = camposEscritos(valores);
  if (texto === '' && notaLimpia === null && escritos.length === 0) {
    return { ok: false, error: 'Escribí el valor o dejá una nota para responder la consulta.' };
  }

  // Camino nuevo: la tarjeta manda un valor por campo.
  if (escritos.length > 0) {
    const leidos = await leerCampos(escritos, campos.some(esCampoDeMedida));
    if (leidos.tipo === 'error') return { ok: false, error: leidos.error };

    // Sin números que escribir, la respuesta es lo que se dijo, no un dato: no
    // se le inventa un atributo a la entidad a partir de texto libre (P4).
    if (leidos.tipo === 'texto') {
      await cerrar(db, hallazgo, actor, 'respondido', {
        tipo: 'nota',
        nota: notaLimpia ?? leidos.texto,
      });
      return { ok: true };
    }

    // Con todo o con nada: un campo que no vino en el payload cierra la
    // consulta igual que uno en cero, y el dato que falta no se vuelve a pedir.
    // El `disabled` de la tarjeta no alcanza — esto es una server action y el
    // cliente puede llamarla con el payload que quiera.
    const faltantes = camposSinResponder(campos, leidos.valores);
    if (faltantes.length > 0) return { ok: false, error: faltanCampos(faltantes) };

    const escrito = await escribirEnEntidad(db, obraId, hallazgo, leidos.valores, actor);
    await cerrar(
      db,
      hallazgo,
      actor,
      'respondido',
      conNota(respuestaDeValores(leidos.valores), notaLimpia),
    );
    if (escrito) await recomputarObra(obraId, { db });
    return { ok: true };
  }

  const numero = texto === '' ? null : await parsearCantidad(texto);

  // Un "0" en una consulta que apunta a un campo de una entidad no es una
  // respuesta: `leerMedida()` solo toma valores positivos, así que el motor
  // seguiría sin poder computar, pero el hallazgo quedaría cerrado y el rubro
  // aprobable con el dato todavía faltando — justo lo que el gate existe para
  // impedir (RF-404). Se rechaza y la consulta sigue abierta.
  if (target !== null && numero !== null && numero <= 0) {
    return { ok: false, error: MEDIDA_NO_POSITIVA };
  }

  // Y lo mismo por el camino del `valor` suelto: sobre una consulta que pide
  // medidas, un `-2`, un `0,90 m` o un `2,o5` no son una nota, son un error de
  // tipeo, y cerrarlos como nota deja la abertura incomputable para siempre
  // (misma razón que en `leerCampos`). Una consulta que pregunta por un texto
  // sí se responde en palabras, y ahí la nota sigue siendo lo correcto.
  if (texto !== '' && numero === null && campos.some(esCampoDeMedida)) {
    return { ok: false, error: noEsUnaMedida(texto) };
  }

  // Un `valor` suelto responde UN campo. Si la consulta pide dos, no hay forma
  // de saber cuál es —y escribir el primero la cerraría con el otro sin cargar,
  // para siempre—: se pide la respuesta completa, que es lo que manda la
  // tarjeta.
  if (numero !== null && campos.length > 1) {
    return { ok: false, error: faltanCampos(campos.slice(1)) };
  }

  const campo = campos[0];

  // Camino bueno: el dato entra a la entidad y el cómputo lo levanta.
  if (target && campo !== undefined && numero !== null) {
    const escrito = await escribirEnEntidad(db, obraId, hallazgo, { [campo]: numero }, actor);
    if (escrito) {
      await cerrar(
        db,
        hallazgo,
        actor,
        'respondido',
        conNota({ tipo: 'valor', campo, valor: numero }, notaLimpia),
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
 * El texto que la tarjeta necesita cuando no hay dato: pedirlo, y decir cuál es
 * la otra salida. Un dato de obra **no** se responde con una nota: la consulta
 * quedaría cerrada, el hecho seguiría faltando y las N entidades que lo esperan
 * seguirían sin computar, sin nada que lo diga (mismo agujero que el "0").
 */
export const DATO_OBRA_SIN_VALOR =
  'Escribí el dato para responder la consulta, o descartala si no aplica a esta obra.';

/**
 * Responde una consulta de **dato de obra** (§5.2): un hecho que vale para toda
 * la obra —la altura de local de PB, la altura de revestimiento del baño—.
 *
 * Es la contracara de la deduplicación de preguntas. A los cuatro tabiques de
 * PB les falta la misma altura y la bandeja lo pregunta **una vez**; responderlo
 * escribe **una** fila en `datos_obra` y el recompute la propaga: los cuatro
 * ítems salen computados en esa misma pasada.
 *
 * Tres cosas que no son negociables:
 *
 *  - **El dato no se escribe en ninguna entidad.** Copiarlo a los cuatro
 *    tabiques haría creer que la planta acota lo que no acota; el valor entra al
 *    cálculo por la cadena de respaldo (`src/lib/rubros/respaldo.ts`) y queda
 *    declarado de dónde salió.
 *  - **`origen: 'explicito'` y `definido_por` = quien contestó.** Lo cargó una
 *    persona: es lo más fuerte que hay, le gana a cualquier deducción y el
 *    pipeline no lo pisa (`datos_obra.definido_por`, `src/db/schema.ts`).
 *  - **P1 se cumple con el origen declarado**, no con un bbox inventado: el dato
 *    no se leyó en ninguna lámina, así que `fuentes_json` va vacío y quien
 *    responde queda anotado en `definido_por`, que es la otra forma válida de
 *    declarar de dónde salió un dato.
 *
 * Un dato **con unidad** es una medida y se valida como tal (positiva, con coma
 * decimal y sin unidad tipeada); uno sin unidad es un texto y entra tal cual
 * (`solado`, `revestimiento`).
 */
async function responderDatoObra(
  db: Db,
  hallazgo: Hallazgo,
  dato: TargetDato,
  crudo: string,
  nota: string | null,
  actor: ActorBandeja,
): Promise<ResultadoAccion> {
  const texto = crudo.trim();
  if (texto === '') return { ok: false, error: DATO_OBRA_SIN_VALOR };

  let valor: number | string = texto;
  if (dato.unidad !== undefined) {
    const numero = await parsearCantidad(texto);
    if (numero === null) return { ok: false, error: noEsUnaMedida(texto) };
    if (numero <= 0) return { ok: false, error: MEDIDA_NO_POSITIVA };
    valor = numero;
  } else if (texto.length > 60) {
    return { ok: false, error: 'El valor no puede pasar de 60 caracteres.' };
  }

  const obraId = hallazgo.obraId;
  const [previo] = await db
    .select()
    .from(datosObra)
    .where(and(eq(datosObra.obraId, obraId), eq(datosObra.clave, dato.clave)));

  const fila = {
    obraId,
    clave: dato.clave,
    valorJson: { valor, ...(dato.unidad === undefined ? {} : { unidad: dato.unidad }) },
    origen: 'explicito' as const,
    fuentesJson: [],
    confianza: 1,
    metodo: null,
    definidoPor: actor.usuarioId,
    updatedAt: new Date(),
  };

  if (previo) {
    await db.update(datosObra).set(fila).where(eq(datosObra.id, previo.id));
  } else {
    await db.insert(datosObra).values(fila);
  }

  await auditar(obraId, actor, 'dato_obra_definido', `datos_obra:${dato.clave}`, {
    valor: { antes: previo?.valorJson.valor ?? null, despues: valor },
    origen: { antes: previo?.origen ?? null, despues: 'explicito' },
    // A cuántas entidades les faltaba: es lo que convierte una respuesta en N
    // ítems computados, y es lo que hay que poder leer después en la auditoría.
    afectadas: dato.entidades.length,
  });

  // Orden de la regla 3 del módulo: el dato, después el hallazgo, y recién ahí
  // el recompute — que cerraría la consulta con su respuesta automática.
  await cerrar(
    db,
    hallazgo,
    actor,
    'respondido',
    conNota({ tipo: 'dato_obra', clave: dato.clave, valor }, nota),
  );
  await recomputarObra(obraId, { db });
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
 *
 * **Decisión 7:** la escala asumida no se confirma por acá. También es un
 * supuesto —la lámina se computó con la escala que declara el rótulo—, pero
 * darlo por bueno acá cerraría la consulta sin poner `escala_confiable = true`
 * ni reprocesar la lámina: la obra quedaría computada sobre una escala que
 * nadie verificó y sin ninguna consulta que lo diga. El camino correcto es
 * `responderHallazgo`, que es lo que hace el botón «Confirmar escala».
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
  if (laminaBloqueada(hallazgo.clave) !== null) {
    return { ok: false, error: ESCALA_NO_ES_SUPUESTO };
  }
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

/**
 * Confirma de una todas las consultas seleccionadas que traen propuesta.
 *
 * Es el botón que hace viable la bandeja de una obra real: la búsqueda dirigida
 * y las lecturas de baja confianza dejan decenas de consultas con el dato ya
 * leído, y confirmarlas de a una es el trabajo que el arquitecto no va a hacer.
 *
 * Las reglas de lote son las de `descartarLote` —o son todas de la obra o no se
 * toca ninguna; las que ya no están abiertas se saltean, no se pisan— más una:
 * **sin `valor_propuesto_json` no hay nada que confirmar** y la consulta se
 * saltea. Una selección puede mezclar consultas con propuesta y sin ella; que
 * el lote falle entero por eso sería inútil.
 *
 * El recompute va **una sola vez al final**: confirmar 20 medidas recalculaba
 * la obra 20 veces para llegar exactamente al mismo resultado.
 */
export async function confirmarLote(
  entrada: EntradaLote,
  actor: ActorBandeja,
  deps: DepsBandeja = {},
): Promise<ResultadoConfirmacionLote> {
  const parseo = zLote.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: primerError(parseo.error, 'No pude leer la selección.') };
  }
  const { obraId, hallazgoIds, nota } = parseo.data;
  const ids = [...new Set(hallazgoIds)];
  const notaLimpia = nota && nota !== '' ? nota : null;

  const db = await getDb();
  const filas = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obraId), inArray(hallazgos.id, ids)));

  if (filas.length !== ids.length) {
    return { ok: false, error: 'Alguna de las consultas seleccionadas no es de esta obra.' };
  }

  let confirmadas = 0;
  let salteadas = 0;
  let huboEscritura = false;

  for (const fila of filas) {
    const propuesta = fila.valorPropuestoJson;
    if (fila.estado !== 'abierto' || !propuesta) {
      salteadas += 1;
      continue;
    }

    // La escala tiene su propio camino: confirmar la asumida marca la lámina
    // como confiable y la reprocesa (decisión 7). Reprocesa una lámina por
    // consulta, no una por lote — son pocas y cada una es su propio análisis.
    const laminaId = laminaBloqueada(fila.clave);
    if (laminaId !== null) {
      const escala = propuesta.valores.escala;
      if (escala === undefined) {
        salteadas += 1;
        continue;
      }
      const resultado = await responderEscala(
        db,
        fila,
        laminaId,
        String(escala).trim(),
        notaLimpia,
        actor,
        deps,
      );
      if (resultado.ok) confirmadas += 1;
      else salteadas += 1;
      continue;
    }

    // Un dato de obra tiene su propio camino: confirmarlo escribe `datos_obra`,
    // no un atributo de una entidad (`propuestaDeDato` en `busqueda.ts` deja el
    // contrato escrito). Recomputa él solo, y por eso no toca `huboEscritura`:
    // el hecho ya está aplicado cuando el lote sigue con la próxima.
    const dato = fila.targetDato;
    if (dato) {
      const propuesto = propuesta.valores[CAMPO_DATO_OBRA];
      const resultado =
        propuesto === undefined
          ? { ok: false as const, error: '' }
          : await responderDatoObra(db, fila, dato, String(propuesto), notaLimpia, actor);
      if (resultado.ok) confirmadas += 1;
      else salteadas += 1;
      continue;
    }

    // **Una propuesta parcial no se confirma.** La búsqueda dirigida puede
    // encontrar el ancho y no el alto: confirmar eso escribiría el ancho y
    // cerraría la consulta para siempre —`recomputarObra` no reabre lo
    // cerrado— con la abertura igual de incomputable y sin nada que diga que
    // el alto quedó sin cargar. Se saltea y queda para que la complete una
    // persona, que es la que puede ir a buscar el dato que falta.
    const campos = camposDelTarget(fila.targetRef);
    const crudos: (readonly [string, string])[] = [];
    for (const campo of campos) {
      const propuesto = propuesta.valores[campo];
      if (propuesto === undefined) continue;
      const texto = typeof propuesto === 'number' ? String(propuesto) : propuesto.trim();
      if (texto !== '') crudos.push([campo, texto] as const);
    }

    // Y una propuesta que no es un número tampoco: entraría a la entidad como
    // atributo sin que nadie la haya mirado (P4).
    const completa = campos.length > 0 && crudos.length === campos.length;
    const leidos = completa ? await leerCampos(crudos, campos.some(esCampoDeMedida)) : null;
    if (leidos === null || leidos.tipo !== 'numeros') {
      salteadas += 1;
      continue;
    }

    if (!(await escribirEnEntidad(db, obraId, fila, leidos.valores, actor))) {
      salteadas += 1;
      continue;
    }
    huboEscritura = true;
    await cerrar(
      db,
      fila,
      actor,
      'respondido',
      conNota(respuestaDeValores(leidos.valores), notaLimpia),
    );
    confirmadas += 1;
  }

  if (huboEscritura) await recomputarObra(obraId, { db });
  return { ok: true, confirmadas, salteadas };
}
