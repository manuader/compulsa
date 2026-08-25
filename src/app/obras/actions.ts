'use server';

/**
 * Alta de obra.
 *
 * `crearObraCore` es el núcleo testeable: recibe la base y el `estudioId` ya
 * resueltos y no sabe nada de Next ni de cookies. `crearObraAction` es el
 * envoltorio que la pantalla usa — resuelve la sesión, arma el payload desde el
 * `FormData` y audita.
 *
 * Nota sobre el `db: Db` como primer parámetro de `crearObraCore`: en un archivo
 * `'use server'` **todo export es un endpoint**. Pedir el handle de la base por
 * parámetro hace que una llamada de afuera falle cerrada (no hay forma de
 * serializar un cliente de Drizzle en el body de una request), y evita la
 * versión peligrosa de la firma —`(estudioId, payload)` leyendo `getDb()` por su
 * cuenta— que sí dejaría crear obras en un estudio ajeno.
 */
import { z } from 'zod';

import { getDb, type Db } from '@/db/client';
import { obras, type Obra } from '@/db/schema';
import { registrarAuditoria } from '@/lib/audit';
import { requireUser } from '@/lib/auth/guards';
import { TIPOS_OBRA } from '@/types/domain';

/**
 * F0 computa en pesos o en dólares; el resto llega con la compulsa (F1).
 * No se exporta: en un archivo `'use server'` solo pueden salir funciones async.
 * La pantalla lista las mismas dos opciones y el server las vuelve a validar.
 */
const MONEDAS = ['ARS', 'USD'] as const;

export type ResultadoCrearObra =
  | { ok: true; obra: Obra }
  | { ok: false; errores: Record<string, string> };

/** Estado que `useActionState` devuelve al formulario. Todo serializable. */
export interface EstadoNuevaObra {
  errores?: Record<string, string>;
  valores?: Record<string, string>;
}

const zNuevaObra = z.object({
  nombre: z
    .string()
    .trim()
    .min(1, 'Poné el nombre de la obra.')
    .max(120, 'El nombre no puede pasar de 120 caracteres.'),
  zona: z
    .string()
    .trim()
    .min(1, 'Poné la zona o localidad de la obra.')
    .max(120, 'La zona no puede pasar de 120 caracteres.'),
  tipo: z.enum(TIPOS_OBRA, { error: 'Elegí si es obra nueva, reforma o ampliación.' }),
  moneda: z.enum(MONEDAS, { error: 'Elegí la moneda con la que vas a computar.' }),
});

/** Primer mensaje por campo: el formulario muestra uno solo debajo de cada input. */
function erroresPorCampo(error: z.ZodError): Record<string, string> {
  const errores: Record<string, string> = {};
  for (const issue of error.issues) {
    const campo = String(issue.path[0] ?? '');
    if (campo && !(campo in errores)) errores[campo] = issue.message;
  }
  return errores;
}

function texto(formData: FormData, campo: string): string {
  const valor = formData.get(campo);
  return typeof valor === 'string' ? valor : '';
}

/**
 * Valida y persiste. El `estudioId` lo pone el server desde la sesión y el
 * `estado` lo pone la base: Zod devuelve solo los cuatro campos del formulario,
 * así que nada de lo que venga de más en el payload llega al insert.
 */
export async function crearObraCore(
  db: Db,
  estudioId: string,
  payload: unknown,
): Promise<ResultadoCrearObra> {
  const parseo = zNuevaObra.safeParse(payload);
  if (!parseo.success) return { ok: false, errores: erroresPorCampo(parseo.error) };

  const [obra] = await db
    .insert(obras)
    .values({ estudioId, ...parseo.data })
    .returning();

  return { ok: true, obra };
}

export async function crearObraAction(
  _estadoPrevio: EstadoNuevaObra,
  formData: FormData,
): Promise<EstadoNuevaObra> {
  const { usuario, estudio } = await requireUser();

  const valores = {
    nombre: texto(formData, 'nombre'),
    zona: texto(formData, 'zona'),
    tipo: texto(formData, 'tipo'),
    moneda: texto(formData, 'moneda'),
  };

  const resultado = await crearObraCore(await getDb(), estudio.id, valores);
  if (!resultado.ok) return { errores: resultado.errores, valores };

  await registrarAuditoria({
    obraId: resultado.obra.id,
    actorTipo: 'usuario',
    actorNombre: usuario.email,
    accion: 'obra_creada',
    targetRef: `obras:${resultado.obra.id}`,
    diff: {
      nombre: resultado.obra.nombre,
      zona: resultado.obra.zona,
      tipo: resultado.obra.tipo,
      moneda: resultado.obra.moneda,
    },
  });

  const [{ revalidatePath }, { redirect }] = await Promise.all([
    import('next/cache'),
    import('next/navigation'),
  ]);
  revalidatePath('/obras');
  return redirect(`/obras/${resultado.obra.id}`);
}
