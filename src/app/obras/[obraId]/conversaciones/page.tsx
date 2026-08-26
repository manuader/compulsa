/**
 * Las conversaciones de la obra (PRD §8.7): un renglón por proveedor
 * contactado, con lo último que se dijo.
 *
 * Es la vista transversal a las compulsas: la pantalla de una compulsa muestra
 * el hilo de **ese** pedido, y esta muestra a quién le estás hablando en toda la
 * obra, sin importar el rubro. Es donde se ve quién quedó esperando respuesta.
 *
 * Las tres consultas de mensajes, banderas y cotizaciones salen **en batch** (un
 * `IN`, no una por contacto): una obra con cuatro rubros compulsados tiene
 * decenas de contactos.
 */
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { getDb } from '@/db/client';
import {
  compulsas,
  conciliacionItems,
  contactosCompulsa,
  cotizaciones,
  mensajes,
  proveedores,
} from '@/db/schema';
import { requireObra, requireUser } from '@/lib/auth/guards';
import { partirCuerpo } from '@/lib/outreach/canal';
import { estadoMensaje } from '@/lib/outreach/threads';
import { PLANTILLAS } from '@/lib/rubros/index';
import type { EstadoContacto } from '@/types/domain';

export const metadata: Metadata = { title: 'Conversaciones' };

const ETIQUETA_CONTACTO: Record<EstadoContacto, string> = {
  pendiente: 'Por mandar',
  contactado: 'Contactado',
  cotizo: 'Cotizó',
  negociando: 'Negociando',
  cerrado: 'Cerrado',
  sin_respuesta: 'Sin respuesta',
};

const TONO_CONTACTO: Record<EstadoContacto, BadgeTone> = {
  pendiente: 'warn',
  contactado: 'info',
  cotizo: 'ok',
  negociando: 'info',
  cerrado: 'neutral',
  sin_respuesta: 'warn',
};

const MOMENTO = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Argentina/Buenos_Aires',
});

/** Primera línea con contenido, recortada: el hilo entero está a un click. */
function resumir(cuerpo: string): string {
  const linea = cuerpo
    .split('\n')
    .map((texto) => texto.trim())
    .find((texto) => texto !== '');
  if (!linea) return '(sin texto)';
  return linea.length > 120 ? `${linea.slice(0, 117)}…` : linea;
}

export default async function ConversacionesPage({
  params,
}: {
  params: Promise<{ obraId: string }>;
}) {
  const { obraId } = await params;
  const obra = await requireObra(obraId);
  await requireUser();
  const db = await getDb();

  const filas = await db
    .select({
      contacto: contactosCompulsa,
      compulsa: compulsas,
      proveedor: proveedores,
    })
    .from(contactosCompulsa)
    .innerJoin(compulsas, eq(compulsas.id, contactosCompulsa.compulsaId))
    .innerJoin(proveedores, eq(proveedores.id, contactosCompulsa.proveedorId))
    .where(eq(compulsas.obraId, obra.id))
    .orderBy(desc(compulsas.createdAt));

  const ids = filas.map((fila) => fila.contacto.id);

  const [todos, sustituciones] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : db.select().from(mensajes).where(inArray(mensajes.contactoId, ids)),
    ids.length === 0
      ? Promise.resolve([])
      : // El detalle de cada bandera sale de `banderasDeContacto` (P5), que es la
        // fuente de verdad; acá solo hace falta el número, y de a uno serían dos
        // consultas por proveedor.
        db
          .select({ contactoId: cotizaciones.contactoId, total: count() })
          .from(conciliacionItems)
          .innerJoin(cotizaciones, eq(cotizaciones.id, conciliacionItems.cotizacionId))
          .where(
            and(
              inArray(cotizaciones.contactoId, ids),
              eq(conciliacionItems.match, 'sustituto'),
            ),
          )
          .groupBy(cotizaciones.contactoId),
  ]);

  const banderasPorContacto = new Map(
    sustituciones.map((fila) => [fila.contactoId, Number(fila.total)]),
  );

  const base = `/obras/${obra.id}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-semibold text-neutral-900">
          {filas.length === 0
            ? 'Todavía no hay conversaciones'
            : filas.length === 1
              ? '1 conversación'
              : `${filas.length} conversaciones`}
        </h1>
        <p className="max-w-2xl text-sm text-neutral-600">
          Todo lo que se habló con cada proveedor de esta obra. El canal es manual: el sistema
          escribe los mensajes y vos los mandás por donde ya hablás con cada uno; lo que contestan
          se registra acá tal cual lo escribieron.
        </p>
      </div>

      {filas.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white px-4 py-10 text-center">
          <p className="text-sm font-medium text-neutral-900">Ningún proveedor contactado.</p>
          <p className="mt-1 text-sm text-neutral-600">
            Aparecen solos al{' '}
            <Link href={`${base}/compulsas/nueva`} className="font-medium text-neutral-900 underline">
              lanzar una compulsa
            </Link>
            .
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {filas.map(({ contacto, compulsa, proveedor }) => {
            const suyos = todos
              .filter((mensaje) => mensaje.contactoId === contacto.id)
              .sort((a, b) => a.at.getTime() - b.at.getTime());
            const ultimo = suyos[suyos.length - 1];
            const pendientes = suyos.filter(
              (mensaje) => estadoMensaje(mensaje) === 'pendiente_envio_manual',
            ).length;
            const banderas = banderasPorContacto.get(contacto.id) ?? 0;

            return (
              <li key={contacto.id}>
                <Link
                  href={`${base}/conversaciones/${contacto.id}`}
                  className="flex flex-col gap-1 rounded-lg border border-neutral-200 bg-white px-4 py-3 transition-colors hover:border-neutral-400"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-neutral-900">{proveedor.nombre}</span>
                    <Badge tone={TONO_CONTACTO[contacto.estado]}>
                      {ETIQUETA_CONTACTO[contacto.estado]}
                    </Badge>
                    <span className="text-xs text-neutral-500">
                      {PLANTILLAS[compulsa.rubro].nombre} · v{compulsa.version}
                    </span>
                    {pendientes > 0 ? (
                      <Badge tone="warn">
                        {pendientes === 1
                          ? '1 mensaje sin mandar'
                          : `${pendientes} mensajes sin mandar`}
                      </Badge>
                    ) : null}
                    {banderas > 0 ? (
                      <Badge tone="error">
                        {banderas === 1 ? '1 sustitución' : `${banderas} sustituciones`}
                      </Badge>
                    ) : null}
                  </div>

                  {ultimo ? (
                    <p className="text-sm text-neutral-700">
                      <span className="text-neutral-500">
                        {ultimo.direccion === 'entrante' ? 'Contestó' : 'Escribimos'} el{' '}
                        {MOMENTO.format(ultimo.at)}:{' '}
                      </span>
                      {/* El cuerpo crudo no se muestra nunca: el bloque de
                          adjuntos se parte, y solo en los salientes (P5). */}
                      {resumir(
                        ultimo.direccion === 'saliente'
                          ? partirCuerpo(ultimo.cuerpo).texto
                          : ultimo.cuerpo,
                      )}
                    </p>
                  ) : (
                    <p className="text-sm text-neutral-500">Sin mensajes todavía.</p>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
