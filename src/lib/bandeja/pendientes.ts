/**
 * Cuántas cosas de una obra esperan una decisión, para el badge de la solapa
 * «Bandeja» del layout.
 *
 * Vive acá y no adentro del `layout.tsx` por una razón concreta: un layout es un
 * Server Component y el repo no tiene renderer de React, así que lo que se
 * escriba ahí adentro no lo mira ningún test. Y este número **ya se equivocó
 * una vez**: cuando la pantalla de deducciones se mudó a la solapa «Para
 * revisar» (§5.8) el contador viejo —que contaba deducciones `propuesta`— pasó a
 * contar consultas abiertas, y las propuestas se quedaron sin ninguna señal en
 * la navegación de la obra. Un dato bajo umbral esperando en «Para revisar» era
 * invisible hasta que alguien entrara a mirar.
 *
 * Las dos mitades y por qué solo estas dos:
 *
 *  - **consultas abiertas** (solapa «Preguntas»): lo que pide un dato y frena la
 *    aprobación de un rubro. Baja a cero cuando se responden o se descartan.
 *  - **deducciones `propuesta`** (solapa «Para revisar»): lo que **no** llegó al
 *    umbral y por eso no entró al cómputo. Es exactamente la cola de trabajo que
 *    contaba el badge viejo, y baja a cero al validarlas o rechazarlas.
 *
 * Lo que **no** entra, y es la mitad del sentido de esta función: las
 * auto-validadas y los ítems `inferido`. Ya están aplicados y no esperan nada
 * (§5.4, §5.5); sumarlos dejaría un número que no baja nunca a cero, y un badge
 * que no baja a cero deja de leerse a la semana.
 *
 * Módulo de lectura: no muta nada y no pide rol — es el mismo criterio del
 * `GET /api/laminas/[laminaId]/marcas`.
 */
import { and, count, eq } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { deducciones, hallazgos } from '@/db/schema';

export interface PendientesDeObra {
  /** Consultas abiertas: la solapa «Preguntas». */
  consultas: number;
  /** Deducciones `propuesta`: lo que espera un visto bueno en «Para revisar». */
  revisiones: number;
  /** Lo que va en el badge. */
  total: number;
}

export async function contarPendientes(db: Db, obraId: string): Promise<PendientesDeObra> {
  const [abiertas, propuestas] = await Promise.all([
    db
      .select({ total: count() })
      .from(hallazgos)
      .where(and(eq(hallazgos.obraId, obraId), eq(hallazgos.estado, 'abierto'))),
    db
      .select({ total: count() })
      .from(deducciones)
      .where(and(eq(deducciones.obraId, obraId), eq(deducciones.estado, 'propuesta'))),
  ]);

  const consultas = abiertas[0]?.total ?? 0;
  const revisiones = propuestas[0]?.total ?? 0;
  return { consultas, revisiones, total: consultas + revisiones };
}

/**
 * El desglose para el `title` del badge.
 *
 * Un número solo miente por omisión: «5» sobre «Bandeja» y después tres
 * consultas en «Preguntas» deja al arquitecto buscando las otras dos. El
 * tooltip dice dónde está cada mitad, y las mitades en cero no se nombran.
 */
export function detallePendientes(pendientes: PendientesDeObra): string {
  const partes: string[] = [];
  if (pendientes.consultas > 0) {
    partes.push(
      pendientes.consultas === 1
        ? '1 consulta abierta en «Preguntas»'
        : `${pendientes.consultas} consultas abiertas en «Preguntas»`,
    );
  }
  if (pendientes.revisiones > 0) {
    partes.push(
      pendientes.revisiones === 1
        ? '1 deducción esperando tu visto bueno en «Para revisar»'
        : `${pendientes.revisiones} deducciones esperando tu visto bueno en «Para revisar»`,
    );
  }
  return partes.length === 0 ? 'No hay nada esperando una decisión' : partes.join(' · ');
}
