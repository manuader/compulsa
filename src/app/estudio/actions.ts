'use server';

/**
 * Endpoints de las pantallas del estudio.
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** con el
 * payload que el cliente quiera, así que acá no hay ni una línea de lógica: los
 * núcleos viven en `@/lib/plataforma/*` —reciben la base y el actor explícitos y
 * aplican la matriz de roles adentro— y este archivo aporta las tres cosas que
 * faltan:
 *
 *   1. `requireUser()` — hay sesión válida.
 *   2. el **actor sale de la sesión**, nunca del payload: ni el `estudioId` ni
 *      el rol se leen de lo que mandó el cliente. Sin eso, un colaborador
 *      podría firmarse como titular de otro estudio.
 *   3. `revalidatePath()` de las pantallas que muestran lo que cambió.
 *
 * Los errores de rol se traducen a texto de pantalla: un 500 no le dice al
 * usuario que le falta permiso.
 */
import { z } from 'zod';

import { getDb } from '@/db/client';
import { esUuid, requireUser } from '@/lib/auth/guards';
import { recomputarObrasDelEstudio } from '@/lib/pipeline/recomputar';
import { guardarItemChecklist, ItemChecklistDesconocidoError } from '@/lib/plataforma/checklists';
import { guardarConfig } from '@/lib/plataforma/config-estudio';
import { marcarLeida, marcarTodasLeidas } from '@/lib/plataforma/notificaciones';
import { RolInsuficienteError, UsuarioInactivoError } from '@/lib/plataforma/roles';
import {
  cambiarActivoUsuario,
  cambiarRolUsuario,
  crearInvitacion,
  UltimoTitularError,
  UsuarioNoEncontradoError,
  type ActorPlataforma,
} from '@/lib/plataforma/usuarios';
import { ROLES_USUARIO, RUBROS } from '@/types/domain';

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoEstudio = { ok: true; mensaje?: string } | { ok: false; error: string };

/** Estado de los formularios con `useActionState`. */
export interface EstadoEstudio {
  mensaje?: string;
  error?: string;
  errores?: Record<string, string>;
}

const zUuid = z.string().refine(esUuid, 'Identificador inválido.');

/** El actor de la sesión: rol y estudio salen de la cookie, no del formulario. */
async function actor(): Promise<ActorPlataforma> {
  const { usuario, estudio } = await requireUser();
  return {
    usuarioId: usuario.id,
    email: usuario.email,
    estudioId: estudio.id,
    rol: usuario.rol,
    activo: usuario.activo,
  };
}

/** El mensaje de los errores que la pantalla sabe mostrar; `null` si no es uno de esos. */
function mensajeConocido(error: unknown): string | null {
  if (
    error instanceof RolInsuficienteError ||
    error instanceof UsuarioInactivoError ||
    error instanceof UltimoTitularError ||
    error instanceof UsuarioNoEncontradoError ||
    error instanceof ItemChecklistDesconocidoError
  ) {
    return error.message;
  }
  return null;
}

async function revalidar(...rutas: string[]): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  for (const ruta of rutas) revalidatePath(ruta);
}

function texto(formData: FormData, campo: string): string {
  const valor = formData.get(campo);
  return typeof valor === 'string' ? valor : '';
}


// ---------------------------------------------------------------------------
// Invitaciones y usuarios
// ---------------------------------------------------------------------------

const zNuevaInvitacion = z.object({
  rol: z.enum(ROLES_USUARIO, { error: 'Elegí el rol de la invitación.' }),
});

export async function crearInvitacionAction(
  _previo: EstadoEstudio,
  formData: FormData,
): Promise<EstadoEstudio> {
  const parseo = zNuevaInvitacion.safeParse({ rol: texto(formData, 'rol') });
  if (!parseo.success) {
    return { error: parseo.error.issues[0]?.message ?? 'Elegí el rol de la invitación.' };
  }

  try {
    const invitacion = await crearInvitacion(await getDb(), await actor(), parseo.data.rol);
    await revalidar('/estudio/usuarios');
    return { mensaje: `Código listo: ${invitacion.codigo}. Vence en 7 días.` };
  } catch (error) {
    const mensaje = mensajeConocido(error);
    if (mensaje) return { error: mensaje };
    throw error;
  }
}

const zCambioRol = z.object({ usuarioId: zUuid, rol: z.enum(ROLES_USUARIO) });

export async function cambiarRolAction(entrada: unknown): Promise<ResultadoEstudio> {
  const parseo = zCambioRol.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: 'No pude leer el cambio de rol.' };

  try {
    await cambiarRolUsuario(
      await getDb(),
      await actor(),
      parseo.data.usuarioId,
      parseo.data.rol,
    );
  } catch (error) {
    const mensaje = mensajeConocido(error);
    if (mensaje) return { ok: false, error: mensaje };
    throw error;
  }

  await revalidar('/estudio/usuarios');
  return { ok: true };
}

const zCambioActivo = z.object({ usuarioId: zUuid, activo: z.boolean() });

export async function cambiarActivoAction(entrada: unknown): Promise<ResultadoEstudio> {
  const parseo = zCambioActivo.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: 'No pude leer la baja del usuario.' };

  try {
    await cambiarActivoUsuario(
      await getDb(),
      await actor(),
      parseo.data.usuarioId,
      parseo.data.activo,
    );
  } catch (error) {
    const mensaje = mensajeConocido(error);
    if (mensaje) return { ok: false, error: mensaje };
    throw error;
  }

  await revalidar('/estudio/usuarios');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

/**
 * Lee un número escrito en es-AR (coma decimal). Vacío ⇒ `null`, que en
 * `desperdiciosPct` significa "sacale el override", no "cero".
 */
function numero(valor: string): number | null {
  const limpio = valor.trim().replace(/\./g, '').replace(',', '.');
  if (limpio === '') return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Arma el payload de configuración desde el formulario.
 *
 * Solo se mandan las secciones que el formulario trae (`__seccion` marca cuál):
 * la pantalla guarda de a bloques y el core mergea, así que guardar los pesos no
 * puede pisar los desperdicios.
 */
export async function guardarConfigAction(
  _previo: EstadoEstudio,
  formData: FormData,
): Promise<EstadoEstudio> {
  const seccion = texto(formData, '__seccion');
  const payload: Record<string, unknown> = {};

  if (seccion === 'desperdicios') {
    const desperdiciosPct: Record<string, number | null> = {};
    for (const rubro of RUBROS) desperdiciosPct[rubro] = numero(texto(formData, `desperdicio.${rubro}`));
    payload.desperdiciosPct = desperdiciosPct;
  } else if (seccion === 'condiciones') {
    payload.condicionesDefault = {
      ivaDiscriminado: true,
      separarManoObraMateriales: formData.get('separarManoObraMateriales') !== null,
      validezMinimaDias: numero(texto(formData, 'validezMinimaDias')) ?? 7,
      plazoEntregaDias: numero(texto(formData, 'plazoEntregaDias')),
      notas: texto(formData, 'notas').trim() || null,
    };
  } else if (seccion === 'mandato') {
    payload.mandatoDefault = {
      objetivoMejoraPct: numero(texto(formData, 'objetivoMejoraPct')) ?? 0,
      palancas: formData.getAll('palancas').filter((v): v is string => typeof v === 'string'),
      maxRondas: 2,
    };
  } else if (seccion === 'pesos') {
    payload.pesosRanking = {
      total: numero(texto(formData, 'peso.total')) ?? 0,
      fidelidad: numero(texto(formData, 'peso.fidelidad')) ?? 0,
      plazo: numero(texto(formData, 'peso.plazo')) ?? 0,
    };
  } else if (seccion === 'mep') {
    const valor = numero(texto(formData, 'mepValor'));
    const fecha = texto(formData, 'mepFecha').trim();
    payload.mepReferencia = valor === null && fecha === '' ? null : { valor, fecha };
  } else {
    return { error: 'No pude leer qué parte de la configuración querías guardar.' };
  }

  try {
    const db = await getDb();
    const quien = await actor();
    const resultado = await guardarConfig(db, quien, payload);
    if (!resultado.ok) return { errores: resultado.errores, error: Object.values(resultado.errores)[0] };

    if (Object.keys(resultado.cambios).length === 0) {
      await revalidar('/estudio/configuracion');
      return { mensaje: 'No había nada que cambiar.' };
    }

    // El desperdicio cambia números ya escritos en las planillas; las otras
    // secciones (condiciones, mandato, pesos, MEP) las lee cada pantalla al
    // renderizar y no tocan el cómputo.
    const recomputadas =
      resultado.cambios.desperdiciosPct === undefined
        ? 0
        : await recomputarObrasDelEstudio(quien.estudioId, { db });

    await revalidar('/estudio/configuracion', '/obras');
    return {
      mensaje:
        recomputadas === 0
          ? 'Listo, guardamos la configuración.'
          : `Listo: guardamos la configuración y recalculamos ${recomputadas === 1 ? 'la obra activa' : `las ${recomputadas} obras activas`}.`,
    };
  } catch (error) {
    const mensaje = mensajeConocido(error);
    if (mensaje) return { error: mensaje };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

const zChecklist = z.object({
  rubro: z.enum(RUBROS),
  itemId: z.string().min(1),
  activo: z.boolean().optional(),
  bloqueante: z.boolean().optional(),
});

export async function guardarChecklistAction(entrada: unknown): Promise<ResultadoEstudio> {
  const parseo = zChecklist.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: 'No pude leer el ítem del checklist.' };
  const { rubro, itemId, activo, bloqueante } = parseo.data;

  try {
    await guardarItemChecklist(await getDb(), await actor(), rubro, itemId, { activo, bloqueante });
  } catch (error) {
    const mensaje = mensajeConocido(error);
    if (mensaje) return { ok: false, error: mensaje };
    throw error;
  }

  await revalidar('/estudio/configuracion');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Notificaciones
// ---------------------------------------------------------------------------

/**
 * Marca la notificación como leída y lleva a donde apunta.
 *
 * Es un `<form>` y no un link porque el click tiene que **escribir** antes de
 * navegar: un `<a>` con un `fetch()` al lado se pierde cuando la navegación
 * gana la carrera.
 */
export async function abrirNotificacionAction(formData: FormData): Promise<never> {
  const { usuario } = await requireUser();
  const id = texto(formData, 'notificacionId');
  if (esUuid(id)) await marcarLeida(await getDb(), usuario.id, id);

  const destino = texto(formData, 'link');
  await revalidar('/estudio');

  const { redirect } = await import('next/navigation');
  // Solo rutas internas: un `link` que venga con `//otro.host` o `javascript:`
  // no es un destino de esta app.
  return redirect(destino.startsWith('/') && !destino.startsWith('//') ? destino : '/estudio');
}

export async function marcarTodasLeidasAction(): Promise<ResultadoEstudio> {
  const { usuario } = await requireUser();
  const total = await marcarTodasLeidas(await getDb(), usuario.id);
  await revalidar('/estudio');
  return { ok: true, mensaje: total === 0 ? 'No había nada sin leer.' : `Marcamos ${total} como leídas.` };
}
