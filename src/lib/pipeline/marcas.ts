/**
 * Las marcas de una lámina: todo lo que el overlay del visor dibuja encima del
 * plano, resuelto contra la base y ya listo para serializar.
 *
 * Vivía adentro de `app/obras/[obraId]/laminas/[laminaId]/page.tsx`, que era el
 * único lugar que mostraba una lámina. Ahora hay dos: esa página y el
 * `PanelVisor` embebido (bandeja, deducciones), que lo pide por
 * `GET /api/laminas/[laminaId]/marcas`. Las dos tienen que dibujar exactamente
 * lo mismo — un bbox que aparece en pantalla completa y no en el panel es un
 * bug de provenance (P1), no una diferencia de vista—, así que el armado es
 * uno solo y vive acá.
 *
 * Los tipos `Marca*` se importan de `overlay.tsx`, que es un `'use client'`:
 * como es un `import type` se borra al compilar y ningún módulo de cliente
 * entra al bundle del server (la página ya lo hacía).
 *
 * **Aislamiento (RNF-4):** toda consulta lleva `obra_id` en el `where`. Este
 * módulo no resuelve pertenencia —eso es de `requireObra`/`requireLaminaApi`—,
 * pero tampoco confía: con un `obraId` que no es el de la lámina devuelve
 * `null`, no las marcas de otra obra.
 */
import { and, eq } from 'drizzle-orm';

import type { MarcaDeduccion, MarcaEntidad, MarcaHallazgo } from '@/components/viewer/overlay';
import type { Db } from '@/db/client';
import { deducciones, entidades, hallazgos, laminas } from '@/db/schema';
import { TITULO_REGLA } from '@/lib/deduccion/memoria';
import { describirValor, etiquetaCampo } from '@/lib/deduccion/motor';
import { valorDeDeduccion } from '@/lib/deduccion/persistencia';
import type { Fuente } from '@/types/domain';

export interface MarcasDeLamina {
  laminaId: string;
  /** Ruta a los bytes de la lámina, la que espera `VisorLamina`. */
  archivoUrl: string;
  entidades: MarcaEntidad[];
  hallazgos: MarcaHallazgo[];
  /** Solo las propuestas: una deducción decidida ya no espera nada. */
  deducciones: MarcaDeduccion[];
}

/**
 * La ruta de descarga de un `archivo_ref`.
 *
 * La ref es una ruta relativa POSIX del storage: cada segmento se codifica por
 * separado para no romper la barra que separa carpetas.
 */
export function urlDeArchivo(archivoRef: string): string {
  return `/api/archivos/${archivoRef.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Todo lo que se dibuja sobre una lámina, o `null` si la lámina no es de esa
 * obra. Quien llama ya validó la sesión y el estudio.
 */
export async function armarMarcasDeLamina(
  db: Db,
  obraId: string,
  laminaId: string,
): Promise<MarcasDeLamina | null> {
  const [lamina] = await db
    .select({ id: laminas.id, archivoRef: laminas.archivoRef })
    .from(laminas)
    .where(and(eq(laminas.id, laminaId), eq(laminas.obraId, obraId)));
  if (!lamina) return null;

  const [filasEntidades, filasHallazgos, filasDeducciones] = await Promise.all([
    db
      .select({
        id: entidades.id,
        tipo: entidades.tipo,
        nombre: entidades.nombre,
        fuentes: entidades.fuentesJson,
      })
      .from(entidades)
      .where(and(eq(entidades.obraId, obraId), eq(entidades.laminaId, lamina.id))),
    db
      .select({
        id: hallazgos.id,
        descripcion: hallazgos.descripcion,
        bloqueante: hallazgos.bloqueante,
        estado: hallazgos.estado,
        fuentes: hallazgos.laminasJson,
      })
      .from(hallazgos)
      .where(eq(hallazgos.obraId, obraId)),
    // La marca va sobre la entidad que la deducción COMPLETARÍA, que es la que
    // hoy está sin acotar: por eso el join es contra `entidades.laminaId`.
    db
      .select({
        id: deducciones.id,
        campo: deducciones.campo,
        regla: deducciones.regla,
        valorJson: deducciones.valorJson,
        fuentesEntidad: entidades.fuentesJson,
      })
      .from(deducciones)
      .innerJoin(entidades, eq(deducciones.entidadId, entidades.id))
      .where(
        and(
          eq(deducciones.obraId, obraId),
          eq(deducciones.estado, 'propuesta'),
          eq(entidades.laminaId, lamina.id),
        ),
      ),
  ]);

  const deEstaLamina = (fuentes: readonly Fuente[]): Fuente[] =>
    fuentes.filter((fuente) => fuente.laminaId === lamina.id);

  const marcasEntidades: MarcaEntidad[] = filasEntidades.flatMap((fila) =>
    deEstaLamina(fila.fuentes).map((fuente) => ({
      id: fila.id,
      tipo: fila.tipo,
      nombre: fila.nombre,
      ...(fuente.detalle === undefined ? {} : { detalle: fuente.detalle }),
      bbox: fuente.bbox,
    })),
  );

  const marcasHallazgos: MarcaHallazgo[] = filasHallazgos
    .filter((fila) => fila.estado !== 'descartado')
    .flatMap((fila) =>
      deEstaLamina(fila.fuentes).map((fuente) => ({
        id: fila.id,
        descripcion: fila.descripcion,
        bloqueante: fila.bloqueante,
        bbox: fuente.bbox,
      })),
    );

  const marcasDeducciones: MarcaDeduccion[] = filasDeducciones.flatMap((fila) => {
    const valor = valorDeDeduccion(fila);
    return deEstaLamina(fila.fuentesEntidad).map((fuente) => ({
      id: fila.id,
      campo: etiquetaCampo(fila.campo),
      valor: valor === null ? '—' : describirValor(fila.campo, valor),
      regla: TITULO_REGLA[fila.regla],
      bbox: fuente.bbox,
    }));
  });

  return {
    laminaId: lamina.id,
    archivoUrl: urlDeArchivo(lamina.archivoRef),
    entidades: marcasEntidades,
    hallazgos: marcasHallazgos,
    deducciones: marcasDeducciones,
  };
}
