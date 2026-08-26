/**
 * Las compulsas de la obra (PRD §8.6).
 *
 * Una fila por compulsa, **todas las versiones incluidas**: RF-701 dice que
 * editar el cómputo crea una versión nueva y cierra la anterior, así que lo que
 * se pidió en la versión 1 tiene que seguir a la vista aunque hoy corra la 2.
 *
 * Server Component: lee con `getDb()` y no baja nada interactivo salvo el CTA.
 * El botón «Nueva compulsa» está deshabilitado —con el motivo en el `title`, no
 * escondido— cuando no hay ningún rubro aprobado o cuando el rol no alcanza:
 * un botón que desaparece deja al usuario buscando qué hizo mal.
 */
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { estilosBoton } from '@/components/ui/button';
import { getDb } from '@/db/client';
import { compulsas, computoRubros, contactosCompulsa } from '@/db/schema';
import { requireObra, requireUser } from '@/lib/auth/guards';
import { esRolSuficiente } from '@/lib/plataforma/roles';
import { PLANTILLAS } from '@/lib/rubros/index';
import type { EstadoCompulsa, EstadoContacto } from '@/types/domain';

export const metadata: Metadata = { title: 'Compulsas' };

const ETIQUETA_ESTADO: Record<EstadoCompulsa, string> = {
  borrador: 'Borrador',
  lanzada: 'En curso',
  cerrada: 'Cerrada',
  adjudicada: 'Adjudicada',
};

const TONO_ESTADO: Record<EstadoCompulsa, BadgeTone> = {
  borrador: 'neutral',
  lanzada: 'info',
  cerrada: 'neutral',
  adjudicada: 'ok',
};

const ETIQUETA_CONTACTO: Record<EstadoContacto, string> = {
  pendiente: 'por mandar',
  contactado: 'contactados',
  cotizo: 'cotizaron',
  negociando: 'negociando',
  cerrado: 'cerrados',
  sin_respuesta: 'sin respuesta',
};

/** El orden en el que se lee el avance de una compulsa. */
const ORDEN_CONTACTO: EstadoContacto[] = [
  'pendiente',
  'contactado',
  'cotizo',
  'negociando',
  'sin_respuesta',
  'cerrado',
];

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'America/Argentina/Buenos_Aires',
});

export default async function CompulsasPage({ params }: { params: Promise<{ obraId: string }> }) {
  const { obraId } = await params;
  const obra = await requireObra(obraId);
  const { usuario } = await requireUser();
  const db = await getDb();

  const filas = await db
    .select()
    .from(compulsas)
    .where(eq(compulsas.obraId, obra.id))
    .orderBy(desc(compulsas.createdAt));

  const porEstado = new Map<string, Map<EstadoContacto, number>>();
  if (filas.length > 0) {
    const contactos = await db
      .select({
        compulsaId: contactosCompulsa.compulsaId,
        estado: contactosCompulsa.estado,
        total: count(),
      })
      .from(contactosCompulsa)
      .where(
        inArray(
          contactosCompulsa.compulsaId,
          filas.map((fila) => fila.id),
        ),
      )
      .groupBy(contactosCompulsa.compulsaId, contactosCompulsa.estado);

    for (const fila of contactos) {
      const cuenta = porEstado.get(fila.compulsaId) ?? new Map<EstadoContacto, number>();
      cuenta.set(fila.estado, Number(fila.total));
      porEstado.set(fila.compulsaId, cuenta);
    }
  }

  const aprobados = await db
    .select({ rubro: computoRubros.rubro })
    .from(computoRubros)
    .where(and(eq(computoRubros.obraId, obra.id), eq(computoRubros.estado, 'aprobado')));

  const esTitular = esRolSuficiente(usuario, 'titular');
  const motivo = !esTitular
    ? 'Lanzar una compulsa es del titular del estudio (RF-1201).'
    : aprobados.length === 0
      ? 'Primero aprobá el cómputo de un rubro: lo que se manda es lo que se aprobó (RF-701).'
      : null;

  const base = `/obras/${obra.id}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold text-neutral-900">
            {filas.length === 0
              ? 'Todavía no pediste precios'
              : filas.length === 1
                ? '1 compulsa'
                : `${filas.length} compulsas`}
          </h1>
          <p className="max-w-2xl text-sm text-neutral-600">
            Cada compulsa congela el cómputo aprobado de un rubro con su hash. Si después editás la
            planilla, volver a pedir precios crea una versión nueva y cierra la anterior — las dos
            quedan acá, con lo que efectivamente se pidió en cada una.
          </p>
        </div>

        {motivo === null ? (
          <Link href={`${base}/compulsas/nueva`} className={estilosBoton('primary')}>
            Nueva compulsa
          </Link>
        ) : (
          <span
            title={motivo}
            aria-disabled="true"
            className={`${estilosBoton('primary')} cursor-not-allowed opacity-50`}
          >
            Nueva compulsa
          </span>
        )}
      </div>

      {motivo !== null ? (
        <p className="rounded-md border border-neutral-300 bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          {motivo}
          {aprobados.length === 0 && esTitular ? (
            <>
              {' '}
              <Link href={`${base}/computo`} className="font-medium text-neutral-900 underline">
                Ir al cómputo
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      {filas.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white px-4 py-10 text-center">
          <p className="text-sm font-medium text-neutral-900">Ninguna compulsa lanzada.</p>
          <p className="mt-1 text-sm text-neutral-600">
            Con un rubro aprobado, «Nueva compulsa» arma el pedido, los recortes de plano y un
            mensaje por proveedor listo para mandar.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {filas.map((compulsa) => {
            const cuenta = porEstado.get(compulsa.id) ?? new Map<EstadoContacto, number>();
            const contactos = [...cuenta.values()].reduce((total, valor) => total + valor, 0);

            return (
              <li key={compulsa.id}>
                <Link
                  href={`${base}/compulsas/${compulsa.id}`}
                  className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-3 transition-colors hover:border-neutral-400"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-neutral-900">
                      {PLANTILLAS[compulsa.rubro].nombre}
                    </span>
                    <Badge tone="neutral">v{compulsa.version}</Badge>
                    <Badge tone={TONO_ESTADO[compulsa.estado]}>
                      {ETIQUETA_ESTADO[compulsa.estado]}
                    </Badge>
                    <span className="text-xs text-neutral-500">
                      {FECHA.format(compulsa.createdAt)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-600">
                    <span>
                      {compulsa.itemsJson.length}{' '}
                      {compulsa.itemsJson.length === 1 ? 'ítem pedido' : 'ítems pedidos'}
                    </span>
                    <span>
                      {contactos} {contactos === 1 ? 'proveedor' : 'proveedores'}
                    </span>
                    {ORDEN_CONTACTO.filter((estado) => (cuenta.get(estado) ?? 0) > 0).map(
                      (estado) => (
                        <span key={estado}>
                          {cuenta.get(estado)} {ETIQUETA_CONTACTO[estado]}
                        </span>
                      ),
                    )}
                    {/* El hash corto es lo que hace verificable RF-701: dos
                        versiones del mismo rubro se distinguen mirándolo. */}
                    <span className="font-mono text-neutral-500">
                      #{compulsa.snapshotHash.slice(0, 8)}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
