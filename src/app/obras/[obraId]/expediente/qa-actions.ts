'use server';

/**
 * Endpoint del Q&A del expediente (RF-106).
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP** con el payload
 * que el cliente quiera: acá no hay lógica de Q&A. El núcleo está en
 * `@/lib/analysis/qa-*` y este archivo aporta lo que falta — sesión, obra del
 * estudio (RNF-4), el armado del contexto desde la base y la traducción de las
 * citas a algo que la pantalla pueda linkear.
 *
 * Preguntar **no muta nada**, así que no pide rol de colaborador: alguien con
 * acceso de lectura a la obra puede leerla también preguntando. Los tokens de la
 * llamada al modelo los audita el provider (`qa_llm`, RNF-7).
 */
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { laminas } from '@/db/schema';
import { getQaProvider, type ContextoQa, type LaminaQa } from '@/lib/analysis/qa-tipos';
import { esUuid, requireObra, requireUser } from '@/lib/auth/guards';

/** Una lámina citada, lista para el chip: id para el link, texto para leer. */
export interface CitaVista {
  laminaId: string;
  etiqueta: string;
}

/** Todo serializable: es lo que vuelve del server a un componente cliente. */
export type ResultadoPregunta =
  | { ok: true; respuesta: string; citas: CitaVista[] }
  | { ok: false; error: string };

const zEntrada = z.object({
  obraId: z.string().refine(esUuid, 'Identificador inválido.'),
  pregunta: z
    .string()
    .trim()
    .min(3, 'Escribí la pregunta con un poco más de detalle.')
    .max(500, 'La pregunta no puede pasar de 500 caracteres.'),
});

/** "A-01 · PLANTA PB", "Lámina 2" — cómo se nombra una lámina en un chip. */
function etiquetaDe(lamina: { codigo: string | null; titulo: string | null; numeroPagina: number }): string {
  const partes = [lamina.codigo, lamina.titulo].filter(
    (parte): parte is string => parte !== null && parte.trim() !== '',
  );
  return partes.length > 0 ? partes.join(' · ') : `Lámina ${lamina.numeroPagina}`;
}

export async function preguntarAlExpedienteAction(entrada: unknown): Promise<ResultadoPregunta> {
  const parseo = zEntrada.safeParse(entrada);
  if (!parseo.success) {
    return { ok: false, error: parseo.error.issues[0]?.message ?? 'No pude leer la pregunta.' };
  }

  await requireUser();
  // Aislamiento RNF-4: la obra que vale es la que devuelve `requireObra`.
  const obra = await requireObra(parseo.data.obraId);
  const db = await getDb();

  const filas = await db
    .select()
    .from(laminas)
    .where(eq(laminas.obraId, obra.id))
    .orderBy(asc(laminas.numeroPagina));

  const vistas: LaminaQa[] = filas.map((lamina) => ({
    id: lamina.id,
    codigo: lamina.codigo,
    titulo: lamina.titulo,
    tipo: lamina.tipo,
    disciplina: lamina.disciplina,
    textoExtraido: lamina.textoExtraido,
  }));

  const contexto: ContextoQa = { obraId: obra.id, obraNombre: obra.nombre, laminas: vistas };

  let respuesta;
  try {
    respuesta = await getQaProvider().responder(parseo.data.pregunta, contexto);
  } catch (error) {
    // El provider real puede caerse (red, cuota). El mensaje es para la pantalla:
    // el detalle técnico no le sirve a nadie del otro lado.
    console.error('Q&A del expediente falló', error);
    return { ok: false, error: 'No pude consultar el expediente ahora. Probá de nuevo en un rato.' };
  }

  const porId = new Map(filas.map((lamina) => [lamina.id, lamina]));

  return {
    ok: true,
    respuesta: respuesta.respuesta,
    citas: respuesta.citas.map((cita) => {
      const lamina = porId.get(cita.laminaId);
      return {
        laminaId: cita.laminaId,
        etiqueta: lamina ? etiquetaDe(lamina) : (cita.codigo ?? 'Lámina'),
      };
    }),
  };
}
