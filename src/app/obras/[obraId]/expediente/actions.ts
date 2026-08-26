'use server';

/**
 * Endpoints del expediente. Hoy uno solo: borrar un documento.
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** con el
 * payload que el cliente quiera, así que acá no hay lógica de dominio: el núcleo
 * está en `@/lib/obras/gestion` y este archivo aporta las tres líneas que
 * faltan — sesión, obra del estudio (RNF-4) y revalidación.
 *
 * Sobre el `obraId` en el payload: una server action no ve el segmento `[obraId]`
 * de la ruta desde la que se la invocó (no hay request de Next adentro de la
 * función), así que la obra viaja en el payload… y por eso mismo **no se usa tal
 * cual**: la que vale es la que devuelve `requireObra()`. Un `obraId` ajeno no
 * llega a la base, se convierte en un 404.
 */
import { z } from 'zod';

import { getDb } from '@/db/client';
import { esUuid, requireObra, requireUser } from '@/lib/auth/guards';
import { DocumentoNoEncontradoError, eliminarDocumento } from '@/lib/obras/gestion';
import { getStorage } from '@/lib/storage/index';

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoAccion = { ok: true } | { ok: false; error: string };

const zUuid = z.string().refine(esUuid, 'Identificador inválido.');

const zEntrada = z.object({ obraId: zUuid, documentoId: zUuid });

export async function eliminarDocumentoAction(entrada: unknown): Promise<ResultadoAccion> {
  const parseo = zEntrada.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: 'No pude leer qué documento borrar.' };

  const { usuario, estudio } = await requireUser();
  const obra = await requireObra(parseo.data.obraId);

  try {
    await eliminarDocumento(
      await getDb(),
      getStorage(),
      estudio.id,
      obra.id,
      parseo.data.documentoId,
      { usuarioId: usuario.id, email: usuario.email },
    );
  } catch (error) {
    if (error instanceof DocumentoNoEncontradoError) return { ok: false, error: error.message };
    throw error;
  }

  // Borrar un documento cambia las láminas, el cómputo y la bandeja: las cuatro
  // pantallas de la obra leen del server y tienen que volver a leer.
  const { revalidatePath } = await import('next/cache');
  revalidatePath(`/obras/${obra.id}/expediente`);
  revalidatePath(`/obras/${obra.id}/computo`);
  revalidatePath(`/obras/${obra.id}/bandeja`);
  revalidatePath(`/obras/${obra.id}`);

  return { ok: true };
}
