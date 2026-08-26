/**
 * Agenda de proveedores del estudio (RF-801): alta, edición, listado,
 * consentimiento de WhatsApp e import masivo.
 *
 * ## Por qué esto NO vive en un archivo `'use server'`
 *
 * La misma razón que en `src/lib/obras/gestion.ts`: en un archivo `'use server'`
 * **todo export es un endpoint HTTP** con el payload que el cliente quiera.
 * Estas funciones reciben `estudioId` y `actor` por parámetro; expuestas como
 * endpoint, cualquiera podría escribir en la agenda de otro estudio firmando con
 * el actor y el rol que se le antoje. Los envoltorios `*Action` viven en
 * `src/app/proveedores/actions.ts` y sacan las dos cosas de la sesión.
 *
 * ## Compliance §13: el opt-out es una calle de una sola mano
 *
 * `marcarOptIn` fecha el consentimiento (`opt_in_registrado_en`) y `marcarOptOut`
 * lo corta. Tres decisiones que este módulo toma y no se pueden aflojar sin
 * volver a leer el §13:
 *
 *  1. **No existe `revertirOptOut`.** No es que la UI no lo ofrezca: la función
 *     no está. Un proveedor que pidió no ser contactado vuelve a la lista solo
 *     si alguien lo carga de nuevo a mano, con su rastro nuevo.
 *  2. **El opt-out apaga el `opt_in_wa`**, así cualquier chequeo ingenuo de
 *     `optInWa` en otro módulo (el outreach de P5, por ejemplo) falla cerrado.
 *     La fecha del consentimiento original **no** se borra: es el registro de
 *     que alguna vez lo dio.
 *  3. **`marcarOptIn` sobre un opt-out lanza `ProveedorNoContactableError`.**
 *     Pedir opt-in a quien dijo que no es exactamente lo que el opt-out prohíbe.
 *
 * La shortlist (`@/lib/proveedores/shortlist`) filtra el opt_out por su cuenta:
 * las dos defensas son a propósito, porque la lista se arma con proveedores que
 * pueden venir de cualquier lado.
 *
 * ## Roles (RF-1201)
 *
 * Gestionar la agenda es de `colaborador` para arriba; `lectura` solo mira. El
 * chequeo está en el **core** y no solo en la UI, como pide el global-constraint
 * de roles. `requireRolCore` es local a este módulo a propósito — ver su
 * comentario.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { proveedores, type Proveedor, type RolUsuario } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { esUuid } from '@/lib/auth/guards';
// Helper genérico de formularios: convierte un `ZodError` en un mensaje por
// campo. Vive en `obras/schema` porque ahí se necesitó primero; no tiene nada de
// obra adentro. TODO(P7): mudarlo a un `src/lib/forms.ts` compartido.
import { erroresPorCampo } from '@/lib/obras/schema';
import {
  normalizarNombre,
  type ErrorImport,
  type FilaProveedor,
} from '@/lib/proveedores/import-csv';
import { RUBROS, type RubroId } from '@/types/domain';

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

/** Quién hace el cambio. Los `*Action` lo sacan de la sesión, nunca del payload. */
export interface ActorProveedor {
  usuarioId: string;
  email: string;
  rol: RolUsuario;
}

/**
 * Los canales de un proveedor, tal cual los guarda `proveedores.contactos_json`
 * (P1: es un **objeto**, no un array — un proveedor, un juego de contactos).
 * Las claves vacías no se guardan: `{}` significa "no sabemos cómo contactarlo".
 */
// `type` y no `interface` a propósito: la columna es `jsonb` tipada como
// `Record<string, unknown>` y TypeScript solo infiere la firma de índice
// implícita para alias de tipo. Con `interface` esto no compila contra el
// `.values()` de Drizzle.
export type ContactosProveedor = {
  telefono?: string;
  email?: string;
  whatsapp?: string;
  contacto?: string;
};

const CLAVES_CONTACTO = ['telefono', 'email', 'whatsapp', 'contacto'] as const;

export type ClaveContacto = (typeof CLAVES_CONTACTO)[number];

/** El único canal con consentimiento explícito hoy (§13). El tipo lo documenta. */
export type CanalOptIn = 'whatsapp';

export type ResultadoAlta =
  | { ok: true; proveedor: Proveedor }
  | { ok: false; errores: Record<string, string> };

export type ResultadoEdicionProveedor =
  | { ok: true; proveedor: Proveedor; cambios: Record<string, { antes: unknown; despues: unknown }> }
  | { ok: false; errores: Record<string, string> };

export interface FiltrosProveedores {
  rubro?: RubroId;
  /** Match normalizado: `'caba'`, `'CABA'` y `' Caba '` son la misma zona. */
  zona?: string;
}

export interface ResumenImport {
  nuevos: number;
  actualizados: number;
  /** Filas que ya estaban tal cual: ni escritura ni auditoría. */
  sinCambios: number;
  /**
   * Filas que pasaron el parser pero rebotaron contra el schema del dominio
   * (topes de largo). Van con el número de línea del archivo.
   *
   * La cuenta cierra: `nuevos + actualizados + sinCambios + errores.length`
   * es siempre el total de filas que entraron.
   */
  errores: ErrorImport[];
  proveedores: Proveedor[];
}

export class ProveedorNoEncontradoError extends Error {
  constructor(readonly proveedorId: string) {
    super('No encontré ese proveedor en la agenda de este estudio.');
    this.name = 'ProveedorNoEncontradoError';
  }
}

export class ProveedorNoContactableError extends Error {
  constructor(readonly proveedorId: string) {
    super(
      'Ese proveedor pidió no ser contactado. El pedido es permanente: no se le puede registrar un opt-in.',
    );
    this.name = 'ProveedorNoContactableError';
  }
}

export class RolInsuficienteError extends Error {
  constructor(
    readonly rol: RolUsuario,
    readonly minimo: RolUsuario,
  ) {
    super(
      minimo === 'titular'
        ? 'Esto lo puede hacer solo el titular del estudio.'
        : 'Tu rol es de solo lectura: la agenda de proveedores la gestionan los colaboradores y el titular.',
    );
    this.name = 'RolInsuficienteError';
  }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const JERARQUIA: Record<RolUsuario, number> = { lectura: 0, colaborador: 1, titular: 2 };

/**
 * El rol del actor alcanza, o no se hace nada.
 *
 * **Pendiente: unificar.** El guard canónico ya existe:
 * `requireAccion` en `src/lib/plataforma/roles.ts`, con la tabla completa de
 * permisos (RF-1201) —aprobar rubros, lanzar compulsas, adjudicar, gestionar
 * usuarios—. Esta copia local nació porque P4 no podía esperarlo y sigue acá
 * porque migrar los cinco llamados cambia la clase del error: hay **tres**
 * `RolInsuficienteError` distintas en el repo (esta, la de `compulsa/flujo.ts` y
 * la de `plataforma/roles.ts`) y los `instanceof` de las pantallas y los tests
 * las distinguen. La jerarquía (`lectura < colaborador < titular`) y la
 * semántica (falla cerrado, lanza, no devuelve booleano) son idénticas
 * justamente para que unificar sea mecánico; los tests de
 * `tests/integration/proveedores.test.ts` («roles (RF-1201)») son los que tienen
 * que seguir pasando sin tocarse.
 */
export function requireRolCore(actor: ActorProveedor, minimo: RolUsuario): void {
  if (JERARQUIA[actor.rol] < JERARQUIA[minimo]) throw new RolInsuficienteError(actor.rol, minimo);
}

/**
 * `true` si al proveedor se le puede escribir por WhatsApp hoy.
 *
 * Existe para que ningún módulo tenga que acordarse de las **dos** condiciones
 * (P5, outreach): el opt-in registrado y la ausencia de opt-out.
 */
export function puedeContactarsePorWhatsapp(
  proveedor: Pick<Proveedor, 'optInWa' | 'optOut'>,
): boolean {
  return proveedor.optInWa && !proveedor.optOut;
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

const RE_MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Campo de contacto opcional: el formulario manda `''` cuando está vacío. */
function zOpcional(max: number, mensaje: string) {
  return z.string().trim().max(max, mensaje).nullish();
}

export const zDatosProveedor = z.object({
  nombre: z
    .string()
    .trim()
    .min(1, 'Poné el nombre del proveedor.')
    .max(160, 'El nombre no puede pasar de 160 caracteres.'),
  rubros: z
    .array(z.enum(RUBROS, { error: 'Ese rubro no existe.' }))
    .min(1, 'Elegí al menos un rubro.'),
  zona: z
    .string()
    .trim()
    .min(1, 'Poné la zona en la que trabaja.')
    .max(120, 'La zona no puede pasar de 120 caracteres.'),
  telefono: zOpcional(60, 'El teléfono no puede pasar de 60 caracteres.'),
  email: zOpcional(160, 'El mail no puede pasar de 160 caracteres.').refine(
    (valor) => !valor || RE_MAIL.test(valor),
    'Escribí un mail válido.',
  ),
  whatsapp: zOpcional(60, 'El WhatsApp no puede pasar de 60 caracteres.'),
  contacto: zOpcional(120, 'El nombre del contacto no puede pasar de 120 caracteres.'),
});

/** La edición manda solo lo que cambia; lo ausente queda como está. */
export const zCambiosProveedor = zDatosProveedor.partial();

export type DatosProveedor = z.input<typeof zDatosProveedor>;
export type CambiosProveedor = z.input<typeof zCambiosProveedor>;

// ---------------------------------------------------------------------------
// Piezas compartidas
// ---------------------------------------------------------------------------

/**
 * Auditoría de plataforma: sin `obra_id` (la agenda es del estudio, no de una
 * obra), con el proveedor en el `target_ref`.
 */
function auditar(
  actor: ActorProveedor,
  accion: string,
  targetRef: string,
  diff: Record<string, unknown>,
): Promise<void> {
  return registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion,
    targetRef,
    diff,
  });
}

/** Los contactos guardados, tipados. La base los tiene como `Record<string, unknown>`. */
export function contactosDe(proveedor: Pick<Proveedor, 'contactosJson'>): ContactosProveedor {
  const crudo = proveedor.contactosJson ?? {};
  const contactos: ContactosProveedor = {};
  for (const clave of CLAVES_CONTACTO) {
    const valor = crudo[clave];
    if (typeof valor === 'string' && valor.trim() !== '') contactos[clave] = valor;
  }
  return contactos;
}

/** Arma el objeto de contactos de un payload, salteando lo vacío. */
function contactosDePayload(datos: Partial<Record<ClaveContacto, string | null | undefined>>) {
  const contactos: ContactosProveedor = {};
  for (const clave of CLAVES_CONTACTO) {
    const valor = datos[clave];
    if (typeof valor === 'string' && valor.trim() !== '') contactos[clave] = valor.trim();
  }
  return contactos;
}

/**
 * Cuántos errores del import entran en el diff de la auditoría. Más que esto no
 * es un rastro, es un volcado (misma regla que las refs de `eliminarObra`).
 */
const MAX_ERRORES_AUDITADOS = 50;

/**
 * Los mensajes de validación de un formulario, en una sola línea legible.
 *
 * El import no tiene dónde poner un error por campo —su unidad es la línea del
 * archivo—, así que los junta. Son los mismos textos en castellano que la
 * pantalla de alta muestra debajo de cada input.
 */
function motivoDeCampos(errores: Record<string, string>): string {
  return Object.values(errores).join(' ');
}

function igualesContactos(a: ContactosProveedor, b: ContactosProveedor): boolean {
  return CLAVES_CONTACTO.every((clave) => (a[clave] ?? null) === (b[clave] ?? null));
}

/**
 * El proveedor es de este estudio, o no existe (RNF-4).
 *
 * Un id ajeno y un id inventado dan el mismo error: no se filtra existencia. Un
 * id que ni siquiera tiene forma de uuid tampoco llega al driver.
 */
export async function requireProveedorCore(
  db: Db,
  estudioId: string,
  proveedorId: string,
): Promise<Proveedor> {
  if (!esUuid(proveedorId)) throw new ProveedorNoEncontradoError(proveedorId);

  const [proveedor] = await db
    .select()
    .from(proveedores)
    .where(eq(proveedores.id, proveedorId));

  if (!proveedor || proveedor.estudioId !== estudioId) {
    throw new ProveedorNoEncontradoError(proveedorId);
  }
  return proveedor;
}

const COLACION = new Intl.Collator('es-AR', { sensitivity: 'base' });

// ---------------------------------------------------------------------------
// Listado
// ---------------------------------------------------------------------------

/**
 * La agenda del estudio, ordenada por nombre.
 *
 * Los filtros se aplican **en memoria** a propósito: la zona matchea normalizada
 * (sin tildes ni mayúsculas), que en SQL sería un `unaccent(lower(...))` con
 * extensión de por medio, y el rubro es un `enum[]` cuyo `@>` obliga a castear
 * el parámetro a mano. Una agenda de estudio son decenas o cientos de filas, no
 * millones. Si algún día pesa, el lugar del `where` es este mismo `select` —el
 * orden por nombre queda igual, porque se hace acá con colación es-AR y no con
 * la del servidor.
 */
export async function listarProveedores(
  db: Db,
  estudioId: string,
  filtros: FiltrosProveedores = {},
): Promise<Proveedor[]> {
  const agenda = await db.select().from(proveedores).where(eq(proveedores.estudioId, estudioId));
  return filtrarProveedores(agenda, filtros);
}

/**
 * El mismo filtro y el mismo orden, sobre una agenda ya leída.
 *
 * Existe para que la pantalla no lea la base dos veces: necesita la agenda
 * completa (para el desplegable de zonas) **y** la filtrada, y son la misma
 * consulta con un `.filter()` de diferencia.
 */
export function filtrarProveedores(
  agenda: readonly Proveedor[],
  filtros: FiltrosProveedores = {},
): Proveedor[] {
  const zona = filtros.zona ? normalizarNombre(filtros.zona) : null;

  return agenda
    .filter((proveedor) => !filtros.rubro || proveedor.rubros.includes(filtros.rubro))
    .filter((proveedor) => !zona || normalizarNombre(proveedor.zona) === zona)
    .sort((a, b) => COLACION.compare(a.nombre, b.nombre));
}

/** Las zonas que hay en la agenda, para poblar el filtro de la pantalla. */
export function zonasDe(agenda: readonly Proveedor[]): string[] {
  const vistas = new Map<string, string>();
  for (const proveedor of agenda) {
    const clave = normalizarNombre(proveedor.zona);
    if (!vistas.has(clave)) vistas.set(clave, proveedor.zona);
  }
  return [...vistas.values()].sort(COLACION.compare);
}

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

/**
 * Alta de un proveedor. `origen` distingue de dónde salió: `'manual'` es el
 * formulario, `'agenda'` el import de CSV (`persistirImport`), `'historico'`
 * queda para cuando F3 los genere solo.
 */
export async function crearProveedor(
  db: Db,
  estudioId: string,
  datos: unknown,
  actor: ActorProveedor,
  origen: Proveedor['origen'] = 'manual',
): Promise<ResultadoAlta> {
  requireRolCore(actor, 'colaborador');

  const parseo = zDatosProveedor.safeParse(datos);
  if (!parseo.success) return { ok: false, errores: erroresPorCampo(parseo.error) };
  const validos = parseo.data;

  const contactos = contactosDePayload(validos);

  const [proveedor] = await db
    .insert(proveedores)
    .values({
      estudioId,
      nombre: validos.nombre,
      rubros: validos.rubros,
      zona: validos.zona,
      contactosJson: contactos,
      origen,
    })
    .returning();

  await auditar(actor, 'proveedor_creado', `proveedores:${proveedor.id}`, {
    nombre: proveedor.nombre,
    rubros: proveedor.rubros,
    zona: proveedor.zona,
    contactos,
    origen,
  });

  return { ok: true, proveedor };
}

// ---------------------------------------------------------------------------
// Edición
// ---------------------------------------------------------------------------

/**
 * Edita los datos del proveedor. Audita **solo lo que cambió**, con antes y
 * después; guardar un formulario sin haber tocado nada no escribe ni audita
 * (misma regla que `editarObra`: una auditoría de un no-cambio es ruido).
 *
 * Los cuatro contactos viajan como campos sueltos y se guardan como un solo
 * objeto: por eso el diff los reporta juntos, bajo la clave `contactos`. Un
 * campo de contacto que llega vacío **borra** esa clave — es la única forma que
 * tiene el formulario de sacar un teléfono viejo.
 *
 * El consentimiento (`opt_in_wa`, `opt_out`) NO se toca acá: tiene sus propias
 * funciones, con su propia auditoría, porque no es un dato de contacto más.
 */
export async function editarProveedor(
  db: Db,
  estudioId: string,
  proveedorId: string,
  cambios: unknown,
  actor: ActorProveedor,
): Promise<ResultadoEdicionProveedor> {
  requireRolCore(actor, 'colaborador');
  const proveedor = await requireProveedorCore(db, estudioId, proveedorId);

  const parseo = zCambiosProveedor.safeParse(cambios);
  if (!parseo.success) return { ok: false, errores: erroresPorCampo(parseo.error) };
  const datos = parseo.data;

  const set: Partial<typeof proveedores.$inferInsert> = {};
  const diff: Record<string, { antes: unknown; despues: unknown }> = {};

  if (datos.nombre !== undefined && datos.nombre !== proveedor.nombre) {
    set.nombre = datos.nombre;
    diff.nombre = { antes: proveedor.nombre, despues: datos.nombre };
  }
  if (datos.zona !== undefined && datos.zona !== proveedor.zona) {
    set.zona = datos.zona;
    diff.zona = { antes: proveedor.zona, despues: datos.zona };
  }
  if (datos.rubros !== undefined && !mismosRubros(proveedor.rubros, datos.rubros)) {
    set.rubros = datos.rubros;
    diff.rubros = { antes: proveedor.rubros, despues: datos.rubros };
  }

  // Los contactos se editan por clave presente: la que no vino queda como está.
  const antesContactos = contactosDe(proveedor);
  const despuesContactos: ContactosProveedor = { ...antesContactos };
  for (const clave of CLAVES_CONTACTO) {
    const valor = datos[clave];
    if (valor === undefined) continue;
    const limpio = (valor ?? '').trim();
    if (limpio === '') delete despuesContactos[clave];
    else despuesContactos[clave] = limpio;
  }
  if (!igualesContactos(antesContactos, despuesContactos)) {
    set.contactosJson = despuesContactos;
    diff.contactos = { antes: antesContactos, despues: despuesContactos };
  }

  if (Object.keys(set).length === 0) return { ok: true, proveedor, cambios: {} };

  const [actualizado] = await db
    .update(proveedores)
    .set(set)
    .where(eq(proveedores.id, proveedor.id))
    .returning();

  await auditar(actor, 'proveedor_editado', `proveedores:${proveedor.id}`, diff);

  return { ok: true, proveedor: actualizado, cambios: diff };
}

function mismosRubros(a: readonly RubroId[], b: readonly RubroId[]): boolean {
  return a.length === b.length && a.every((rubro, indice) => rubro === b[indice]);
}

// ---------------------------------------------------------------------------
// Consentimiento (PRD §13)
// ---------------------------------------------------------------------------

/**
 * Registra que el proveedor **aceptó** recibir mensajes del estudio por
 * WhatsApp, con la fecha (`opt_in_registrado_en`).
 *
 * Idempotente: marcarlo dos veces no vuelve a fechar el consentimiento ni deja
 * una segunda auditoría — la fecha que vale es la del día que lo dio.
 *
 * Sobre un proveedor con opt-out **lanza**: ver el encabezado del módulo.
 */
export async function marcarOptIn(
  db: Db,
  estudioId: string,
  proveedorId: string,
  canal: CanalOptIn,
  actor: ActorProveedor,
): Promise<Proveedor> {
  requireRolCore(actor, 'colaborador');
  const proveedor = await requireProveedorCore(db, estudioId, proveedorId);

  if (proveedor.optOut) throw new ProveedorNoContactableError(proveedor.id);
  if (proveedor.optInWa) return proveedor;

  const registradoEn = new Date();
  const [actualizado] = await db
    .update(proveedores)
    .set({ optInWa: true, optInRegistradoEn: registradoEn })
    .where(eq(proveedores.id, proveedor.id))
    .returning();

  await auditar(actor, 'proveedor_opt_in', `proveedores:${proveedor.id}`, {
    canal,
    nombre: proveedor.nombre,
    optInWa: { antes: false, despues: true },
    optInRegistradoEn: registradoEn.toISOString(),
  });

  return actualizado;
}

/**
 * El proveedor pidió no ser contactado. **Permanente**: no hay función que lo
 * revierta (§13), y el `opt_in_wa` se apaga para que cualquier chequeo de otro
 * módulo falle cerrado.
 *
 * Idempotente igual que el opt-in: marcarlo dos veces no deja dos auditorías.
 */
export async function marcarOptOut(
  db: Db,
  estudioId: string,
  proveedorId: string,
  actor: ActorProveedor,
): Promise<Proveedor> {
  requireRolCore(actor, 'colaborador');
  const proveedor = await requireProveedorCore(db, estudioId, proveedorId);

  if (proveedor.optOut) return proveedor;

  const [actualizado] = await db
    .update(proveedores)
    // `optInRegistradoEn` queda como está: es el registro histórico de que
    // alguna vez consintió, y borrarlo sería borrar el rastro del §13.
    .set({ optOut: true, optInWa: false })
    .where(eq(proveedores.id, proveedor.id))
    .returning();

  await auditar(actor, 'proveedor_opt_out', `proveedores:${proveedor.id}`, {
    nombre: proveedor.nombre,
    optOut: { antes: false, despues: true },
    optInWa: { antes: proveedor.optInWa, despues: false },
  });

  return actualizado;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Persiste las filas que `importarCsv` dio por buenas (RF-801).
 *
 * **Deduplica por nombre normalizado** (sin tildes, en minúsculas, espacios
 * colapsados) contra la agenda del estudio y contra las filas ya procesadas del
 * mismo archivo: pegar dos veces el mismo CSV no duplica a nadie.
 *
 * Sobre un proveedor que ya está, el import **suma y no pisa**:
 *
 *  - **rubros:** unión, respetando el orden que ya tenía;
 *  - **contactos:** completa las claves que faltan y deja las que ya estaban.
 *    Un CSV es un pegote masivo; el dato curado a mano en la agenda vale más
 *    que el que vino en el archivo. Lo mismo con el nombre y la zona: la fila
 *    del CSV no los reescribe.
 *
 * Una fila que no cambia nada no escribe ni audita: por eso el resumen distingue
 * `actualizados` de `sinCambios`, que es lo que la pantalla necesita para no
 * mentir con un "2 actualizados" cuando no tocó nada.
 *
 * ## Ninguna fila desaparece en silencio
 *
 * `importarCsv` valida el **formato** (columnas, rubros que existen, mail con
 * forma de mail) y no los **topes de largo**, que son del dominio y viven en
 * `zDatosProveedor`. Así que una fila puede pasar el parser y rebotar acá: un
 * nombre de 200 caracteres, una zona de 300, un teléfono interminable.
 *
 * Esas filas salen en `resumen.errores` con su número de línea y el motivo en
 * castellano — **no** se saltean calladas. Es la misma promesa que hace el
 * parser ("una línea mala no rompe el archivo") llevada hasta el final: si
 * `nuevos + actualizados + sinCambios + errores.length` no diera el total de
 * filas, el resumen de la pantalla estaría mintiendo.
 *
 * Los topes no se duplican en `import-csv.ts` a propósito: habría dos fuentes
 * de verdad para el mismo límite y una se atrasaría. El schema del dominio es
 * la única, y el import la consulta —para el alta **y para el merge**, que
 * escribe rubros y contactos que también tienen que pasar por ella—.
 */
export async function persistirImport(
  db: Db,
  estudioId: string,
  filas: readonly FilaProveedor[],
  actor: ActorProveedor,
): Promise<ResumenImport> {
  requireRolCore(actor, 'colaborador');

  const resumen: ResumenImport = {
    nuevos: 0,
    actualizados: 0,
    sinCambios: 0,
    errores: [],
    proveedores: [],
  };
  if (filas.length === 0) return resumen;

  const agenda = await db.select().from(proveedores).where(eq(proveedores.estudioId, estudioId));
  const porNombre = new Map(agenda.map((proveedor) => [normalizarNombre(proveedor.nombre), proveedor]));

  for (const fila of filas) {
    const clave = normalizarNombre(fila.nombre);
    const existente = porNombre.get(clave);

    if (!existente) {
      const alta = await crearProveedor(
        db,
        estudioId,
        {
          nombre: fila.nombre,
          rubros: fila.rubros,
          zona: fila.zona,
          telefono: fila.telefono,
          email: fila.email,
        },
        actor,
        'agenda',
      );
      // El parser no capea largos; el schema del dominio sí. Una fila que rebota
      // acá no rompe el import, pero tampoco desaparece: sale como error con su
      // línea.
      if (!alta.ok) {
        resumen.errores.push({ linea: fila.linea, motivo: motivoDeCampos(alta.errores) });
        continue;
      }

      porNombre.set(clave, alta.proveedor);
      resumen.proveedores.push(alta.proveedor);
      resumen.nuevos += 1;
      continue;
    }

    const rubros = [...existente.rubros];
    for (const rubro of fila.rubros) if (!rubros.includes(rubro)) rubros.push(rubro);

    const contactos = contactosDe(existente);
    const delCsv = contactosDePayload({ telefono: fila.telefono, email: fila.email });
    for (const [campo, valor] of Object.entries(delCsv) as [ClaveContacto, string][]) {
      if (contactos[campo] === undefined) contactos[campo] = valor;
    }

    const cambioRubros = !mismosRubros(existente.rubros, rubros);
    const cambioContactos = !igualesContactos(contactosDe(existente), contactos);

    if (!cambioRubros && !cambioContactos) {
      resumen.sinCambios += 1;
      resumen.proveedores.push(existente);
      continue;
    }

    // El merge escribe rubros y contactos, así que pasa por el MISMO schema que
    // el alta: sin esto, un mail de 300 caracteres que el parser deja pasar
    // entraría por la puerta de atrás solo porque el proveedor ya existía.
    const validacion = zDatosProveedor.safeParse({
      nombre: existente.nombre,
      rubros,
      zona: existente.zona,
      ...contactos,
    });
    if (!validacion.success) {
      resumen.errores.push({
        linea: fila.linea,
        motivo: `«${existente.nombre}» ya estaba en la agenda y no pude actualizarlo: ${motivoDeCampos(
          erroresPorCampo(validacion.error),
        )}`,
      });
      resumen.proveedores.push(existente);
      continue;
    }

    const [actualizado] = await db
      .update(proveedores)
      .set({ rubros, contactosJson: contactos })
      .where(eq(proveedores.id, existente.id))
      .returning();

    const diff: Record<string, unknown> = { via: 'import' };
    if (cambioRubros) diff.rubros = { antes: existente.rubros, despues: rubros };
    if (cambioContactos) {
      diff.contactos = { antes: contactosDe(existente), despues: contactos };
    }
    await auditar(actor, 'proveedor_editado', `proveedores:${existente.id}`, diff);

    porNombre.set(clave, actualizado);
    resumen.proveedores.push(actualizado);
    resumen.actualizados += 1;
  }

  await auditar(actor, 'proveedores_importados', `proveedores:import`, {
    filas: filas.length,
    nuevos: resumen.nuevos,
    actualizados: resumen.actualizados,
    sinCambios: resumen.sinCambios,
    // Las filas rechazadas también quedan en el rastro: si alguien pregunta
    // después por qué su proveedor no está, la respuesta está en la auditoría y
    // no solo en una pantalla que ya se cerró.
    rechazados: resumen.errores.length,
    errores: resumen.errores.slice(0, MAX_ERRORES_AUDITADOS),
  });

  return resumen;
}
