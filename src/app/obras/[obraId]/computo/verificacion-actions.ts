'use server';

/**
 * Endpoint de la doble pasada (RF-306).
 *
 * En un archivo `'use server'` **todo export es un endpoint HTTP**: acá no hay
 * lógica de verificación. El núcleo está en `@/lib/pipeline/verificacion` —que
 * exige el rol por su cuenta, porque esconder el botón no esconde el endpoint— y
 * este archivo aporta sesión, obra del estudio (RNF-4), el formateo de los
 * números para la pantalla y la revalidación de las vistas que cambian.
 *
 * Verificar puede tardar: relee todas las láminas analizadas con el provider. La
 * pantalla lo dice y deja el botón deshabilitado mientras corre.
 */
import { z } from 'zod';

import { getDb } from '@/db/client';
import { ETIQUETA_UNIDAD, formatearNumero } from '@/lib/computo/unidades';
import { esUuid, requireObra, requireUser } from '@/lib/auth/guards';
import {
  verificarComputo,
  VerificacionFallidaError,
  type DiferenciaVerificacion,
  type MotivoDiferencia,
} from '@/lib/pipeline/verificacion';
import { RolInsuficienteError, UsuarioInactivoError } from '@/lib/plataforma/roles';

/** Una diferencia lista para mostrar: los números ya escritos en es-AR. */
export interface DiferenciaVista {
  clave: string;
  claveItem: string;
  descripcion: string;
  motivo: MotivoDiferencia;
  /** "31,68 m²" o "—" si esa pasada no lo encontró. */
  antes: string;
  despues: string;
  /** "9,09 %" o `null` si el ítem aparece en una sola pasada. */
  desvio: string | null;
}

export type ResultadoVerificacionAccion =
  | {
      ok: true;
      laminasLeidas: number;
      itemsComparados: number;
      diferencias: DiferenciaVista[];
    }
  | { ok: false; error: string };

const zEntrada = z.object({ obraId: z.string().refine(esUuid, 'Identificador inválido.') });

function cantidad(valor: number | null, unidad: keyof typeof ETIQUETA_UNIDAD): string {
  return valor === null ? '—' : `${formatearNumero(valor)} ${ETIQUETA_UNIDAD[unidad]}`;
}

function comoVista(diferencia: DiferenciaVerificacion): DiferenciaVista {
  return {
    clave: diferencia.clave,
    claveItem: diferencia.claveItem,
    descripcion: diferencia.descripcion,
    motivo: diferencia.motivo,
    antes: cantidad(diferencia.cantComputo, diferencia.unidad),
    despues: cantidad(diferencia.cantVerificacion, diferencia.unidad),
    desvio: diferencia.desvioPct === null ? null : `${formatearNumero(diferencia.desvioPct)} %`,
  };
}

export async function verificarComputoAction(
  entrada: unknown,
): Promise<ResultadoVerificacionAccion> {
  const parseo = zEntrada.safeParse(entrada);
  if (!parseo.success) return { ok: false, error: 'No pude leer qué obra verificar.' };

  const { usuario } = await requireUser();
  const obra = await requireObra(parseo.data.obraId);

  try {
    const resultado = await verificarComputo(
      await getDb(),
      {},
      {
        usuarioId: usuario.id,
        email: usuario.email,
        rol: usuario.rol,
        activo: usuario.activo,
      },
      obra.id,
    );

    // La verificación escribe consultas: la bandeja y el tablero tienen que
    // volver a leer del server.
    const { revalidatePath } = await import('next/cache');
    revalidatePath(`/obras/${obra.id}/computo`);
    revalidatePath(`/obras/${obra.id}/bandeja`);
    revalidatePath(`/obras/${obra.id}`);

    return {
      ok: true,
      laminasLeidas: resultado.laminasLeidas,
      itemsComparados: resultado.itemsComparados,
      diferencias: resultado.diferencias.map(comoVista),
    };
  } catch (error) {
    // El rol lo exige el core: acá se traduce a un mensaje de pantalla.
    if (error instanceof RolInsuficienteError || error instanceof UsuarioInactivoError) {
      return { ok: false, error: error.message };
    }
    if (error instanceof VerificacionFallidaError) return { ok: false, error: error.message };
    throw error;
  }
}
