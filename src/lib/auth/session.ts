/**
 * Sesiones: token opaco en la tabla `sesiones` + cookie httpOnly.
 *
 * Las funciones `*Core` reciben la base por parámetro y no tocan Next: son las
 * que se testean. Las de más abajo son su envoltorio para el runtime de Next
 * (leen/escriben la cookie con `next/headers`, importado en forma perezosa para
 * que este módulo se pueda cargar fuera de una request).
 */
import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { getDb, type Db } from '@/db/client';
import { estudios, sesiones, usuarios, type Estudio, type Usuario } from '@/db/schema';

import { hashearPassword, verificarPassword } from './password';

export const COOKIE_SESION = 'compulsa_session';

/** 30 días. */
export const DURACION_SESION_MS = 30 * 24 * 60 * 60 * 1000;

export interface SesionActiva {
  usuario: Usuario;
  estudio: Estudio;
}

export interface AltaSesion {
  sesion: SesionActiva;
  token: string;
}

export interface DatosAlta {
  nombreEstudio: string;
  nombre: string;
  email: string;
  password: string;
}

export interface Credenciales {
  email: string;
  password: string;
}

export class EmailYaRegistradoError extends Error {
  constructor(readonly email: string) {
    super('Ya hay una cuenta registrada con ese mail.');
    this.name = 'EmailYaRegistradoError';
  }
}

/** El mail es la identidad: siempre normalizado, para que el unique index sirva. */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
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

// --- Núcleo testeable ------------------------------------------------------

export async function crearSesion(
  db: Db,
  usuarioId: string,
): Promise<{ token: string; expiraAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiraAt = new Date(Date.now() + DURACION_SESION_MS);
  await db.insert(sesiones).values({ token, usuarioId, expiraAt });
  return { token, expiraAt };
}

export async function leerSesion(db: Db, token: string): Promise<SesionActiva | null> {
  const [fila] = await db
    .select({ usuario: usuarios, estudio: estudios, expiraAt: sesiones.expiraAt })
    .from(sesiones)
    .innerJoin(usuarios, eq(sesiones.usuarioId, usuarios.id))
    .innerJoin(estudios, eq(usuarios.estudioId, estudios.id))
    .where(eq(sesiones.token, token));

  if (!fila || fila.expiraAt.getTime() <= Date.now()) return null;
  return { usuario: fila.usuario, estudio: fila.estudio };
}

export async function borrarSesion(db: Db, token: string): Promise<void> {
  await db.delete(sesiones).where(eq(sesiones.token, token));
}

/** Alta de un estudio nuevo con su usuario titular. Atómica: o van los dos, o ninguno. */
export async function registrarEstudioCore(db: Db, datos: DatosAlta): Promise<AltaSesion> {
  const email = normalizarEmail(datos.email);
  const passwordHash = await hashearPassword(datos.password);

  let creado: SesionActiva;
  try {
    creado = await db.transaction(async (tx) => {
      const [estudio] = await tx.insert(estudios).values({ nombre: datos.nombreEstudio }).returning();
      const [usuario] = await tx
        .insert(usuarios)
        .values({ estudioId: estudio.id, email, nombre: datos.nombre, passwordHash, rol: 'titular' })
        .returning();
      return { usuario, estudio };
    });
  } catch (error) {
    if (esViolacionDeUnicidad(error)) throw new EmailYaRegistradoError(email);
    throw error;
  }

  const { token } = await crearSesion(db, creado.usuario.id);
  return { sesion: creado, token };
}

/** `null` si el mail no existe o la contraseña no coincide — nunca se distingue cuál. */
export async function loginCore(db: Db, credenciales: Credenciales): Promise<AltaSesion | null> {
  const email = normalizarEmail(credenciales.email);
  const [fila] = await db
    .select({ usuario: usuarios, estudio: estudios })
    .from(usuarios)
    .innerJoin(estudios, eq(usuarios.estudioId, estudios.id))
    .where(eq(usuarios.email, email));

  if (!fila) return null;
  if (!(await verificarPassword(credenciales.password, fila.usuario.passwordHash))) return null;

  const { token } = await crearSesion(db, fila.usuario.id);
  return { sesion: { usuario: fila.usuario, estudio: fila.estudio }, token };
}

// --- Envoltorios para Next (cookie de por medio) ---------------------------

async function cookieStore() {
  const { cookies } = await import('next/headers');
  return cookies();
}

/**
 * Deja la cookie de sesión para un token ya creado.
 *
 * Es público porque el alta por invitación (`@/lib/plataforma/usuarios`) crea la
 * sesión con `crearSesion()` y necesita cerrar el círculo sin duplicar los
 * flags de la cookie: `httpOnly`, `sameSite` y `secure` se definen **una sola
 * vez**, acá. Una segunda copia en otro módulo es una que un día se va a
 * quedar sin `httpOnly`.
 */
export async function guardarCookieSesion(token: string): Promise<void> {
  return guardarCookie(token);
}

async function guardarCookie(token: string): Promise<void> {
  const store = await cookieStore();
  store.set(COOKIE_SESION, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(DURACION_SESION_MS / 1000),
  });
}

export async function registrarEstudio(datos: DatosAlta): Promise<SesionActiva> {
  const { sesion, token } = await registrarEstudioCore(await getDb(), datos);
  await guardarCookie(token);
  return sesion;
}

export async function login(credenciales: Credenciales): Promise<SesionActiva | null> {
  const alta = await loginCore(await getDb(), credenciales);
  if (!alta) return null;
  await guardarCookie(alta.token);
  return alta.sesion;
}

export async function logout(): Promise<void> {
  const store = await cookieStore();
  const token = store.get(COOKIE_SESION)?.value;
  if (token) await borrarSesion(await getDb(), token);
  store.delete(COOKIE_SESION);
}

export async function getSession(): Promise<SesionActiva | null> {
  const store = await cookieStore();
  const token = store.get(COOKIE_SESION)?.value;
  if (!token) return null;
  return leerSesion(await getDb(), token);
}
