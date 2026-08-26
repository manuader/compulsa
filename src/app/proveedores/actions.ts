'use server';

/**
 * Envoltorios de la agenda de proveedores.
 *
 * Los núcleos viven en `@/lib/proveedores/gestion` —reciben estudio, actor y rol
 * explícitos y no saben quién los llama—; acá abajo están **solo** las tres
 * líneas que faltan: `requireUser()` (hay sesión), el `estudio.id` y el `rol`
 * sacados de esa sesión (nunca del payload), y la revalidación de la pantalla.
 *
 * Que el rol viaje desde la sesión y no desde el formulario es la mitad del
 * enforcement de RF-1201; la otra mitad es que el core lo chequea igual aunque
 * lo llamen de otro lado.
 *
 * El texto del CSV se **vuelve a parsear acá** aunque la pantalla ya lo haya
 * parseado para el preview: el server no confía en el payload
 * (`src/app/CLAUDE.md` §7), así que lo que se persiste sale de `importarCsv`
 * corriendo en el server sobre el texto crudo, no de las filas que mandó el
 * cliente.
 */
import { z } from 'zod';

import { getDb } from '@/db/client';
import { esUuid, requireUser } from '@/lib/auth/guards';
import {
  crearProveedor,
  editarProveedor,
  marcarOptIn,
  marcarOptOut,
  persistirImport,
  ProveedorNoContactableError,
  ProveedorNoEncontradoError,
  RolInsuficienteError,
  type ActorProveedor,
} from '@/lib/proveedores/gestion';
import { importarCsv, type ErrorImport } from '@/lib/proveedores/import-csv';

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoAccionProveedor = { ok: true } | { ok: false; error: string };

export type ResultadoEdicionProveedorAction =
  | { ok: true }
  | { ok: false; error?: string; errores?: Record<string, string> };

export interface EstadoNuevoProveedor {
  errores?: Record<string, string>;
  valores?: { nombre: string; rubros: string[]; zona: string; telefono: string; email: string };
  mensaje?: string;
}

export interface ResumenImportAction {
  nuevos: number;
  actualizados: number;
  sinCambios: number;
  errores: ErrorImport[];
}

export type ResultadoImportAction =
  | { ok: true; resumen: ResumenImportAction }
  | { ok: false; error: string };

const PAYLOAD_ILEGIBLE = 'No pude leer los datos del proveedor.';

const zUuid = z.string().refine(esUuid, 'Identificador inválido.');

function texto(formData: FormData, campo: string): string {
  const valor = formData.get(campo);
  return typeof valor === 'string' ? valor : '';
}

/** Sesión + actor con el rol de la sesión. Nunca el que venga en el payload. */
async function contexto(): Promise<{ estudioId: string; actor: ActorProveedor }> {
  const { usuario, estudio } = await requireUser();
  return {
    estudioId: estudio.id,
    actor: { usuarioId: usuario.id, email: usuario.email, rol: usuario.rol },
  };
}

async function revalidar(): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  revalidatePath('/proveedores');
}

/**
 * Traduce los errores del core a algo que la pantalla pueda mostrar. Un error
 * que no es de dominio se relanza: un 500 honesto es mejor que un cartel
 * genérico que esconde un bug.
 */
function mensajeDeDominio(error: unknown): string | null {
  if (
    error instanceof RolInsuficienteError ||
    error instanceof ProveedorNoEncontradoError ||
    error instanceof ProveedorNoContactableError
  ) {
    return error.message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

export async function crearProveedorAction(
  _estadoPrevio: EstadoNuevoProveedor,
  formData: FormData,
): Promise<EstadoNuevoProveedor> {
  const { estudioId, actor } = await contexto();

  // Los checkboxes de rubros llegan repetidos con el mismo `name`.
  const rubros = formData.getAll('rubros').filter((v): v is string => typeof v === 'string');
  const valores = {
    nombre: texto(formData, 'nombre'),
    rubros,
    zona: texto(formData, 'zona'),
    telefono: texto(formData, 'telefono'),
    email: texto(formData, 'email'),
  };

  let resultado;
  try {
    resultado = await crearProveedor(await getDb(), estudioId, valores, actor);
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { mensaje, valores };
  }

  if (!resultado.ok) return { errores: resultado.errores, valores };

  await revalidar();
  const { redirect } = await import('next/navigation');
  return redirect('/proveedores');
}

// ---------------------------------------------------------------------------
// Edición y consentimiento (desde la fila del listado)
// ---------------------------------------------------------------------------

const zEdicion = z.object({
  proveedorId: zUuid,
  nombre: z.string(),
  rubros: z.array(z.string()),
  zona: z.string(),
  telefono: z.string(),
  email: z.string(),
});

export async function editarProveedorAction(
  entrada: unknown,
): Promise<ResultadoEdicionProveedorAction> {
  const parseo = zEdicion.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: PAYLOAD_ILEGIBLE };
  const { proveedorId, ...cambios } = parseo.data;

  const { estudioId, actor } = await contexto();

  try {
    const resultado = await editarProveedor(
      await getDb(),
      estudioId,
      proveedorId,
      cambios,
      actor,
    );
    if (!resultado.ok) return { ok: false, errores: resultado.errores };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }

  await revalidar();
  return { ok: true };
}

const zProveedor = z.object({ proveedorId: zUuid });

/**
 * Registra el consentimiento de WhatsApp. La pantalla lo pide con el texto de
 * compliance a la vista; acá se guarda con fecha y auditoría (§13).
 */
export async function marcarOptInAction(entrada: unknown): Promise<ResultadoAccionProveedor> {
  const parseo = zProveedor.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: PAYLOAD_ILEGIBLE };

  const { estudioId, actor } = await contexto();

  try {
    await marcarOptIn(await getDb(), estudioId, parseo.data.proveedorId, 'whatsapp', actor);
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }

  await revalidar();
  return { ok: true };
}

/** «No contactar». Permanente: no hay action que lo revierta (§13). */
export async function marcarOptOutAction(entrada: unknown): Promise<ResultadoAccionProveedor> {
  const parseo = zProveedor.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: PAYLOAD_ILEGIBLE };

  const { estudioId, actor } = await contexto();

  try {
    await marcarOptOut(await getDb(), estudioId, parseo.data.proveedorId, actor);
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }

  await revalidar();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const zImport = z.object({ texto: z.string().max(500_000, 'El CSV es demasiado grande.') });

/**
 * Persiste un CSV pegado en la pantalla de import.
 *
 * Vuelve a parsear el texto acá: el preview que vio el usuario lo calculó el
 * cliente con la misma función pura, pero lo que se escribe sale del parseo del
 * server. Los errores por línea vuelven para que el resumen final diga «X
 * nuevos, Y actualizados, Z errores» con los tres números medidos, no
 * estimados.
 */
export async function importarProveedoresAction(entrada: unknown): Promise<ResultadoImportAction> {
  const parseo = zImport.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: parseo.error.issues[0]?.message ?? 'No pude leer el CSV.' };
  }

  const { estudioId, actor } = await contexto();
  const { filas, errores } = importarCsv(parseo.data.texto);

  try {
    const resumen = await persistirImport(await getDb(), estudioId, filas, actor);
    await revalidar();
    return {
      ok: true,
      resumen: {
        nuevos: resumen.nuevos,
        actualizados: resumen.actualizados,
        sinCambios: resumen.sinCambios,
        errores,
      },
    };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}
