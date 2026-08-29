'use server';

/**
 * Endpoints de la lista de precios del estudio.
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** con el
 * payload que el cliente quiera, así que acá no hay lógica: el núcleo vive en
 * `@/lib/precios/gestion` —recibe el actor explícito y aplica la matriz de roles
 * adentro— y este archivo aporta las cuatro cosas que faltan:
 *
 *   1. `requireUser()` — hay sesión válida.
 *   2. el **actor sale de la sesión**, nunca del payload: ni el `estudioId` ni
 *      el rol se leen de lo que mandó el cliente.
 *   3. la fecha de hoy, que el núcleo no mira (`fechaHoyIso()`), para las filas
 *      del CSV que no traen fecha.
 *   4. `revalidatePath()` de la pantalla.
 *
 * El texto del CSV se **vuelve a parsear acá** aunque la pantalla ya lo haya
 * parseado para el preview: el server no confía en el payload
 * (`src/app/CLAUDE.md` §8), así que lo que se persiste sale de
 * `importarCsvPrecios` corriendo en el server sobre el texto crudo, no de las
 * filas que mandó el cliente.
 */
import { z } from 'zod';

import { getDb } from '@/db/client';
import { esUuid, requireUser } from '@/lib/auth/guards';
import { RolInsuficienteError, UsuarioInactivoError } from '@/lib/plataforma/roles';
import {
  eliminarPrecio,
  fechaHoyIso,
  guardarPrecio,
  persistirImportPrecios,
  PrecioNoEncontradoError,
  type ActorPrecios,
} from '@/lib/precios/gestion';
import { importarCsvPrecios, parsearPrecio, type ErrorImportPrecio } from '@/lib/precios/import-csv';

/** Estado del formulario de alta/edición, con `useActionState`. */
export interface EstadoPrecio {
  errores?: Record<string, string>;
  /** Lo que el usuario había escrito, para no perderlo cuando algo falla. */
  valores?: {
    claveItem: string;
    descripcion: string;
    unidad: string;
    precio: string;
    moneda: string;
    fecha: string;
  };
  mensaje?: string;
  error?: string;
}

export type ResultadoPrecioAction = { ok: true } | { ok: false; error: string };

export interface ResumenImportPreciosAction {
  nuevos: number;
  actualizados: number;
  sinCambios: number;
  errores: ErrorImportPrecio[];
}

export type ResultadoImportPreciosAction =
  | { ok: true; resumen: ResumenImportPreciosAction }
  | { ok: false; error: string };

const zUuid = z.string().refine(esUuid, 'Identificador inválido.');

function texto(formData: FormData, campo: string): string {
  const valor = formData.get(campo);
  return typeof valor === 'string' ? valor : '';
}

/** Sesión + actor con el rol de la sesión. Nunca el que venga en el payload. */
async function contexto(): Promise<ActorPrecios> {
  const { usuario, estudio } = await requireUser();
  return {
    usuarioId: usuario.id,
    email: usuario.email,
    estudioId: estudio.id,
    rol: usuario.rol,
    activo: usuario.activo,
  };
}

async function revalidar(): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  revalidatePath('/estudio/precios');
}

/**
 * Traduce los errores del core a algo que la pantalla pueda mostrar. Un error
 * que no es de dominio se relanza: un 500 honesto es mejor que un cartel
 * genérico que esconde un bug.
 */
function mensajeDeDominio(error: unknown): string | null {
  if (
    error instanceof RolInsuficienteError ||
    error instanceof UsuarioInactivoError ||
    error instanceof PrecioNoEncontradoError
  ) {
    return error.message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Alta y edición
// ---------------------------------------------------------------------------

/**
 * Alta o pisada de un precio. Es el mismo endpoint para las dos cosas porque
 * el core es un upsert por `(estudio, clave_item)`: cargar una clave que ya
 * está la actualiza, no la duplica.
 */
export async function guardarPrecioAction(
  _previo: EstadoPrecio,
  formData: FormData,
): Promise<EstadoPrecio> {
  const valores = {
    claveItem: texto(formData, 'claveItem'),
    descripcion: texto(formData, 'descripcion'),
    unidad: texto(formData, 'unidad'),
    precio: texto(formData, 'precio'),
    moneda: texto(formData, 'moneda'),
    fecha: texto(formData, 'fecha'),
  };

  // El mismo parser que el CSV: «145.000,50» se escribe igual en el formulario
  // que en el Excel. `null` cae en el mensaje de `zDatosPrecio` como NaN.
  const precio = parsearPrecio(valores.precio);

  try {
    const resultado = await guardarPrecio(
      await getDb(),
      await contexto(),
      {
        ...valores,
        precio: precio ?? Number.NaN,
        moneda: valores.moneda.trim() === '' ? undefined : valores.moneda,
        fecha: valores.fecha.trim() === '' ? fechaHoyIso() : valores.fecha,
      },
      'manual',
    );

    if (!resultado.ok) return { errores: resultado.errores, valores };

    await revalidar();
    if (resultado.creado) return { mensaje: `Guardamos ${resultado.precio.claveItem}.` };
    if (Object.keys(resultado.cambios).length === 0) {
      return { mensaje: 'No había nada que cambiar.' };
    }
    return { mensaje: `Actualizamos ${resultado.precio.claveItem}.` };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { error: mensaje, valores };
  }
}

// ---------------------------------------------------------------------------
// Borrado
// ---------------------------------------------------------------------------

const zBorrado = z.object({ precioId: zUuid });

export async function eliminarPrecioAction(entrada: unknown): Promise<ResultadoPrecioAction> {
  const parseo = zBorrado.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: 'No pude leer qué precio querías borrar.' };

  try {
    await eliminarPrecio(await getDb(), await contexto(), parseo.data.precioId);
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
 * Persiste un CSV pegado en la pantalla.
 *
 * Los errores del parser (formato) y los de la persistencia (topes del dominio)
 * son la misma cosa para el usuario —líneas que no entraron—, así que vuelven
 * juntos y ordenados por línea, como los ve en el archivo.
 */
export async function importarPreciosAction(
  entrada: unknown,
): Promise<ResultadoImportPreciosAction> {
  const parseo = zImport.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: parseo.error.issues[0]?.message ?? 'No pude leer el CSV.' };
  }

  const { filas, errores } = importarCsvPrecios(parseo.data.texto);

  try {
    const resumen = await persistirImportPrecios(
      await getDb(),
      await contexto(),
      filas,
      fechaHoyIso(),
    );
    await revalidar();
    return {
      ok: true,
      resumen: {
        nuevos: resumen.nuevos,
        actualizados: resumen.actualizados,
        sinCambios: resumen.sinCambios,
        errores: [...errores, ...resumen.errores].sort((a, b) => a.linea - b.linea),
      },
    };
  } catch (error) {
    const mensaje = mensajeDeDominio(error);
    if (!mensaje) throw error;
    return { ok: false, error: mensaje };
  }
}
