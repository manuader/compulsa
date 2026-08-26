/**
 * Usuarios del estudio: invitaciones por código, alta por invitación, cambio de
 * rol y baja lógica (RF-1201).
 *
 * ## Por qué el código y no un mail
 *
 * No hay canal de mail configurado (los adapters de outreach son de P5 y el
 * único activo es `manual`), así que la invitación es un **código legible** que
 * el titular le pasa a la persona por donde quiera. El código es la PK de la
 * tabla: no hay id secuencial que adivinar, y el alfabeto saca las letras que se
 * confunden dictadas por teléfono (O/0, I/1, L).
 *
 * ## Las cuatro reglas del módulo
 *
 * 1. **Una invitación se usa una sola vez.** `usada_por` no nulo la quema,
 *    aunque no haya vencido; vencida y usada dan el **mismo** error, para no
 *    contarle a un desconocido qué códigos existen.
 * 2. **Aceptarla suma al estudio que la emitió**, con el rol de la invitación.
 *    Nunca crea un estudio: ese es el otro camino (`registrarEstudioCore`).
 * 3. **El estudio no se queda sin titular activo.** Ni bajándose de rol ni
 *    desactivándose: el último titular activo se queda donde está. Sin esta
 *    regla, un estudio puede quedar sin nadie que pueda aprobar un rubro,
 *    lanzar una compulsa ni reactivar a nadie — y no habría forma de salir
 *    desde adentro del producto.
 * 4. **Todo se audita** y todo pasa por `requireAccion`: gestionar usuarios es
 *    una de las cinco acciones de titular.
 */
import { randomInt } from 'node:crypto';

import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { estudios, invitaciones, usuarios, type Invitacion } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { hashearPassword } from '@/lib/auth/password';
import {
  crearSesion,
  EmailYaRegistradoError,
  normalizarEmail,
  type AltaSesion,
} from '@/lib/auth/session';
import { crearNotificacion } from '@/lib/plataforma/notificaciones';
import { ETIQUETA_ROL, requireAccion, type UsuarioConRol } from '@/lib/plataforma/roles';
import type { RolUsuario } from '@/types/domain';

/** Quién hace el cambio: la sesión ya resuelta, con su rol y su estudio. */
export interface ActorPlataforma extends UsuarioConRol {
  usuarioId: string;
  email: string;
  estudioId: string;
}

/** Vigencia de una invitación, en días. */
export const DIAS_INVITACION = 7;

/**
 * Alfabeto sin los caracteres que se confunden dictando el código por teléfono:
 * sin O ni 0, sin I ni 1, sin L. 32 símbolos × 8 posiciones = 2^40 códigos.
 */
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.replace('L', '');
const LARGO_CODIGO = 8;

/** Código aleatorio con `randomInt` (CSPRNG): un código adivinable es una puerta abierta. */
export function generarCodigoInvitacion(): string {
  let codigo = '';
  for (let i = 0; i < LARGO_CODIGO; i += 1) {
    codigo += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
  }
  return codigo;
}

/** Lo que se tipea puede venir con espacios y en minúsculas. */
export function normalizarCodigo(codigo: string): string {
  return codigo.trim().toUpperCase();
}

/**
 * Invitación inexistente, ya usada o vencida. **Un solo mensaje para las tres**:
 * distinguirlas le contaría a cualquiera qué códigos existen y cuáles se usaron.
 * El detalle de por qué falló queda en `motivo`, para el log, no para la
 * pantalla.
 */
export class InvitacionInvalidaError extends Error {
  constructor(readonly motivo: 'inexistente' | 'usada' | 'vencida') {
    super(
      'Ese código de invitación no sirve: puede estar mal escrito, ya usado o vencido. Pedile uno nuevo al titular del estudio.',
    );
    this.name = 'InvitacionInvalidaError';
  }
}

export class UsuarioNoEncontradoError extends Error {
  constructor(readonly usuarioId: string) {
    super('No encontré ese usuario en tu estudio.');
    this.name = 'UsuarioNoEncontradoError';
  }
}

export class UltimoTitularError extends Error {
  constructor(readonly accion: 'rol' | 'baja') {
    super(
      accion === 'rol'
        ? 'Sos el único titular activo del estudio: nombrá a otro titular antes de cambiar tu rol.'
        : 'Sos el único titular activo del estudio: nombrá a otro titular antes de darte de baja.',
    );
    this.name = 'UltimoTitularError';
  }
}

// ---------------------------------------------------------------------------
// Invitaciones
// ---------------------------------------------------------------------------

/**
 * Crea una invitación con un código nuevo. Reintenta ante una colisión de PK:
 * con 2^40 códigos vivos siete días no va a pasar, pero "no va a pasar" no es
 * una estrategia de manejo de errores.
 */
export async function crearInvitacion(
  db: Db,
  actor: ActorPlataforma,
  rol: RolUsuario,
): Promise<Invitacion> {
  requireAccion(actor, 'gestionar_usuarios');

  const expiraAt = new Date(Date.now() + DIAS_INVITACION * 24 * 60 * 60 * 1000);

  let invitacion: Invitacion | undefined;
  for (let intento = 0; intento < 5 && !invitacion; intento += 1) {
    const codigo = generarCodigoInvitacion();
    const [existente] = await db
      .select({ codigo: invitaciones.codigo })
      .from(invitaciones)
      .where(eq(invitaciones.codigo, codigo));
    if (existente) continue;

    [invitacion] = await db
      .insert(invitaciones)
      .values({ codigo, estudioId: actor.estudioId, rol, expiraAt })
      .returning();
  }
  if (!invitacion) throw new Error('No pude generar un código de invitación libre. Probá de nuevo.');

  await registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: 'invitacion_creada',
    targetRef: `invitaciones:${invitacion.codigo}`,
    diff: { rol, expiraAt: invitacion.expiraAt.toISOString() },
  });

  return invitacion;
}

/** Las invitaciones del estudio, en el orden en que se generaron. */
export function listarInvitaciones(db: Db, estudioId: string): Promise<Invitacion[]> {
  return db
    .select()
    .from(invitaciones)
    .where(eq(invitaciones.estudioId, estudioId))
    .orderBy(asc(invitaciones.createdAt));
}

/** La invitación usable, o `InvitacionInvalidaError`. No la quema. */
export async function leerInvitacionUsable(db: Db, codigo: string): Promise<Invitacion> {
  const [invitacion] = await db
    .select()
    .from(invitaciones)
    .where(eq(invitaciones.codigo, normalizarCodigo(codigo)));

  if (!invitacion) throw new InvitacionInvalidaError('inexistente');
  if (invitacion.usadaPor !== null) throw new InvitacionInvalidaError('usada');
  if (invitacion.expiraAt.getTime() <= Date.now()) throw new InvitacionInvalidaError('vencida');
  return invitacion;
}

export interface AltaPorInvitacion {
  codigo: string;
  nombre: string;
  email: string;
  password: string;
}

/**
 * Alta de un usuario dentro de un estudio existente.
 *
 * Es el gemelo de `registrarEstudioCore` para el otro camino del `/register`:
 * mismo hash, misma sesión, misma traducción del `23505` a
 * `EmailYaRegistradoError` — pero **sin crear estudio**.
 *
 * La invitación se quema **dentro de la misma transacción** que crea el usuario
 * y con `usada_por IS NULL` en el `where`: dos personas que mandan el mismo
 * código al mismo tiempo no pueden entrar las dos. La que pierde la carrera se
 * lleva el mismo error que un código inventado.
 */
export async function aceptarInvitacionCore(db: Db, datos: AltaPorInvitacion): Promise<AltaSesion> {
  const invitacion = await leerInvitacionUsable(db, datos.codigo);
  const email = normalizarEmail(datos.email);
  const passwordHash = await hashearPassword(datos.password);

  let creado;
  try {
    creado = await db.transaction(async (tx) => {
      const [usuario] = await tx
        .insert(usuarios)
        .values({
          estudioId: invitacion.estudioId,
          email,
          nombre: datos.nombre.trim(),
          passwordHash,
          rol: invitacion.rol,
        })
        .returning();

      const quemadas = await tx
        .update(invitaciones)
        .set({ usadaPor: usuario.id })
        .where(and(eq(invitaciones.codigo, invitacion.codigo), isNull(invitaciones.usadaPor)))
        .returning({ codigo: invitaciones.codigo });

      // Si otro la usó entre el chequeo y el update, el rollback se lleva
      // también al usuario recién creado: o entra con una invitación válida, o
      // no entra.
      if (quemadas.length === 0) throw new InvitacionInvalidaError('usada');

      const [estudio] = await tx.select().from(estudios).where(eq(estudios.id, invitacion.estudioId));
      return { usuario, estudio };
    });
  } catch (error) {
    if (esViolacionDeUnicidad(error)) throw new EmailYaRegistradoError(email);
    throw error;
  }

  const { token } = await crearSesion(db, creado.usuario.id);

  await registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: creado.usuario.email,
    accion: 'invitacion_usada',
    targetRef: `invitaciones:${invitacion.codigo}`,
    diff: { rol: invitacion.rol, usuarioId: creado.usuario.id, estudioId: invitacion.estudioId },
  });

  await crearNotificacion(
    db,
    { estudioId: invitacion.estudioId, roles: ['titular'] },
    {
      titulo: 'Se sumó alguien al estudio',
      cuerpo: `${creado.usuario.nombre} (${creado.usuario.email}) usó una invitación y entró como ${ETIQUETA_ROL[invitacion.rol].toLowerCase()}.`,
      link: '/estudio/usuarios',
    },
  );

  return { sesion: creado, token };
}

/** Busca un `23505` (unique_violation) en la cadena de causas del error. */
function esViolacionDeUnicidad(error: unknown): boolean {
  let actual: unknown = error;
  for (let saltos = 0; saltos < 5 && actual != null; saltos += 1) {
    if ((actual as { code?: string }).code === '23505') return true;
    actual = (actual as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Gestión de usuarios
// ---------------------------------------------------------------------------

/** Lo que la pantalla de usuarios muestra. Sin `passwordHash`, nunca. */
export interface UsuarioListado {
  id: string;
  nombre: string;
  email: string;
  rol: RolUsuario;
  activo: boolean;
  createdAt: Date;
}

export function listarUsuarios(db: Db, estudioId: string): Promise<UsuarioListado[]> {
  return db
    .select({
      id: usuarios.id,
      nombre: usuarios.nombre,
      email: usuarios.email,
      rol: usuarios.rol,
      activo: usuarios.activo,
      createdAt: usuarios.createdAt,
    })
    .from(usuarios)
    .where(eq(usuarios.estudioId, estudioId))
    .orderBy(asc(usuarios.nombre));
}

/** El usuario, o `UsuarioNoEncontradoError` si no es del estudio del actor (RNF-4). */
async function requireUsuarioDelEstudio(db: Db, estudioId: string, usuarioId: string) {
  const [usuario] = await db
    .select()
    .from(usuarios)
    .where(and(eq(usuarios.id, usuarioId), eq(usuarios.estudioId, estudioId)));
  if (!usuario) throw new UsuarioNoEncontradoError(usuarioId);
  return usuario;
}

/** Cuántos titulares **activos** quedan además de este. */
async function otrosTitularesActivos(db: Db, estudioId: string, usuarioId: string): Promise<number> {
  const [fila] = await db
    .select({ total: count() })
    .from(usuarios)
    .where(
      and(
        eq(usuarios.estudioId, estudioId),
        eq(usuarios.rol, 'titular'),
        eq(usuarios.activo, true),
        ne(usuarios.id, usuarioId),
      ),
    );
  return fila?.total ?? 0;
}

export async function cambiarRolUsuario(
  db: Db,
  actor: ActorPlataforma,
  usuarioId: string,
  rol: RolUsuario,
): Promise<UsuarioListado> {
  requireAccion(actor, 'gestionar_usuarios');
  const usuario = await requireUsuarioDelEstudio(db, actor.estudioId, usuarioId);
  if (usuario.rol === rol) return aListado(usuario);

  if (usuario.rol === 'titular' && usuario.activo && rol !== 'titular') {
    if ((await otrosTitularesActivos(db, actor.estudioId, usuarioId)) === 0) {
      throw new UltimoTitularError('rol');
    }
  }

  const [actualizado] = await db
    .update(usuarios)
    .set({ rol })
    .where(eq(usuarios.id, usuario.id))
    .returning();

  await registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: 'usuario_rol_cambiado',
    targetRef: `usuarios:${usuario.email}`,
    diff: { rol: { antes: usuario.rol, despues: rol } },
  });

  return aListado(actualizado);
}

export async function cambiarActivoUsuario(
  db: Db,
  actor: ActorPlataforma,
  usuarioId: string,
  activo: boolean,
): Promise<UsuarioListado> {
  requireAccion(actor, 'gestionar_usuarios');
  const usuario = await requireUsuarioDelEstudio(db, actor.estudioId, usuarioId);
  if (usuario.activo === activo) return aListado(usuario);

  if (!activo && usuario.rol === 'titular') {
    if ((await otrosTitularesActivos(db, actor.estudioId, usuarioId)) === 0) {
      throw new UltimoTitularError('baja');
    }
  }

  const [actualizado] = await db
    .update(usuarios)
    .set({ activo })
    .where(eq(usuarios.id, usuario.id))
    .returning();

  await registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: actor.email,
    accion: 'usuario_activo_cambiado',
    targetRef: `usuarios:${usuario.email}`,
    diff: { activo: { antes: usuario.activo, despues: activo } },
  });

  return aListado(actualizado);
}

function aListado(usuario: {
  id: string;
  nombre: string;
  email: string;
  rol: RolUsuario;
  activo: boolean;
  createdAt: Date;
}): UsuarioListado {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    rol: usuario.rol,
    activo: usuario.activo,
    createdAt: usuario.createdAt,
  };
}
