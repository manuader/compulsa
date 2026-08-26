/**
 * El hilo completo con un proveedor (PRD §8.7).
 *
 * Lo que esta pantalla cuida:
 *
 *  - **Los salientes se muestran sin el bloque de adjuntos** y con los recortes
 *    como links de descarga; **los entrantes, crudos y completos**. Es la regla
 *    de `leerHilo` (P5): el único que compone el bloque es el sistema, y un
 *    entrante que cita el pedido entero se lee tal cual lo escribió el proveedor.
 *  - **Las banderas de sustitución linkean a su cotización** en la pantalla de la
 *    compulsa, que es donde se decide qué hacer con ellas (RF-1002).
 *  - **El estado se puede corregir a mano**, pero «cotizó» solo si hay una
 *    cotización registrada (ver `cambiarEstadoContactoCore`).
 */
import { desc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getDb } from '@/db/client';
import { cotizaciones } from '@/db/schema';
import { requireObra, requireUser } from '@/lib/auth/guards';
import { formatearNumero } from '@/lib/computo/unidades';
import { banderasDeContacto, ContactoNoEncontradoError, leerHilo } from '@/lib/outreach/threads';
import { esRolSuficiente } from '@/lib/plataforma/roles';
import { contactosDe } from '@/lib/proveedores/gestion';
import { PLANTILLAS } from '@/lib/rubros/index';
import type { EstadoContacto } from '@/types/domain';

import { BotonCopiar } from '../../compulsas/ui';
import { AccionesEstado, FormularioEntrante } from '../ui';

export const metadata: Metadata = { title: 'Conversación' };

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

export default async function ConversacionPage({
  params,
}: {
  params: Promise<{ obraId: string; contactoId: string }>;
}) {
  const { obraId, contactoId } = await params;
  const obra = await requireObra(obraId);
  const { usuario, estudio } = await requireUser();
  const db = await getDb();

  let hilo;
  try {
    hilo = await leerHilo(db, estudio.id, contactoId);
  } catch (error) {
    if (error instanceof ContactoNoEncontradoError) notFound();
    throw error;
  }
  // El contacto es de una obra del estudio, pero puede no ser la de la URL.
  if (hilo.contexto.obra.id !== obra.id) notFound();

  const [banderas, cotizadas] = await Promise.all([
    banderasDeContacto(db, estudio.id, contactoId),
    db
      .select()
      .from(cotizaciones)
      .where(eq(cotizaciones.contactoId, contactoId))
      .orderBy(desc(cotizaciones.createdAt)),
  ]);

  const { contacto, compulsa, proveedor } = hilo.contexto;
  const canales = contactosDe(proveedor);
  const puedeEscribir = esRolSuficiente(usuario, 'colaborador');
  const base = `/obras/${obra.id}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link
          href={`${base}/conversaciones`}
          className="text-sm text-neutral-500 hover:text-neutral-900"
        >
          ← Volver a conversaciones
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold text-neutral-900">{proveedor.nombre}</h1>
          <Badge tone={TONO_CONTACTO[contacto.estado]}>{ETIQUETA_CONTACTO[contacto.estado]}</Badge>
          {proveedor.optOut ? <Badge tone="error">No contactar</Badge> : null}
        </div>
        <p className="text-sm text-neutral-600">
          {PLANTILLAS[compulsa.rubro].nombre} · versión {compulsa.version} ·{' '}
          <Link href={`${base}/compulsas/${compulsa.id}`} className="font-medium underline">
            ver la compulsa
          </Link>
          {[canales.contacto, canales.telefono, canales.email]
            .filter((valor): valor is string => !!valor)
            .map((valor) => ` · ${valor}`)
            .join('')}
        </p>
      </div>

      {/* --- Banderas rojas (RF-1002) -------------------------------------- */}
      {banderas.length > 0 ? (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-red-900">
              {banderas.length === 1
                ? 'Cotizó otra especificación en 1 ítem'
                : `Cotizó otra especificación en ${banderas.length} ítems`}
            </h2>
            <p className="text-xs text-red-900">
              Una sustitución frena la negociación automática: la decisión es tuya.
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {banderas.map((bandera) => (
                <li key={`${bandera.cotizacionId}-${bandera.claveItem}`} className="text-sm text-red-900">
                  <strong className="font-medium">{bandera.claveItem}</strong>: {bandera.nota}{' '}
                  <Link
                    href={`${base}/compulsas/${compulsa.id}#cotizacion-${bandera.cotizacionId}`}
                    className="underline"
                  >
                    Ver la cotización
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* --- Cotizaciones -------------------------------------------------- */}
      {cotizadas.length > 0 ? (
        <Card>
          <CardContent className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">
              {cotizadas.length === 1 ? 'Cotización recibida' : 'Cotizaciones recibidas'}
            </h2>
            <ul className="flex flex-col gap-1">
              {cotizadas.map((cotizacion) => (
                <li key={cotizacion.id} className="text-sm text-neutral-800">
                  <Link
                    href={`${base}/compulsas/${compulsa.id}#cotizacion-${cotizacion.id}`}
                    className="font-medium underline"
                  >
                    {MOMENTO.format(cotizacion.createdAt)}
                  </Link>{' '}
                  · {cotizacion.lineasJson.length}{' '}
                  {cotizacion.lineasJson.length === 1 ? 'línea' : 'líneas'} ·{' '}
                  {cotizacion.total === null
                    ? 'sin total declarado'
                    : `${cotizacion.moneda} ${formatearNumero(cotizacion.total, 2)}`}
                  {cotizacion.scoreFidelidad === null
                    ? ''
                    : ` · fidelidad ${Math.round(cotizacion.scoreFidelidad * 100)}%`}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* --- El hilo -------------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">
              {hilo.mensajes.length === 1 ? '1 mensaje' : `${hilo.mensajes.length} mensajes`}
            </h2>
            {hilo.pendientes > 0 ? (
              <span className="text-xs text-neutral-600">
                {hilo.pendientes === 1
                  ? '1 mensaje escrito y sin mandar — se marca desde la compulsa.'
                  : `${hilo.pendientes} mensajes escritos y sin mandar — se marcan desde la compulsa.`}
              </span>
            ) : null}
          </div>

          {hilo.mensajes.length === 0 ? (
            <p className="text-sm text-neutral-600">Todavía no hay nada escrito.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {hilo.mensajes.map((mensaje) => (
                <li
                  key={mensaje.id}
                  className={[
                    'rounded-md border px-3 py-2',
                    mensaje.direccion === 'saliente'
                      ? 'border-neutral-200 bg-white'
                      : 'border-sky-200 bg-sky-50',
                  ].join(' ')}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={mensaje.direccion === 'saliente' ? 'neutral' : 'info'}>
                      {mensaje.direccion === 'saliente' ? 'Nuestro' : 'Del proveedor'}
                    </Badge>
                    {mensaje.estado === 'pendiente_envio_manual' ? (
                      <Badge tone="warn">Pendiente de envío</Badge>
                    ) : null}
                    <span className="text-xs text-neutral-500">{MOMENTO.format(mensaje.at)}</span>
                  </div>

                  <pre className="mt-2 text-sm whitespace-pre-wrap text-neutral-800">
                    {mensaje.texto}
                  </pre>

                  {mensaje.adjuntos.length > 0 ? (
                    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-neutral-500">Recortes de plano:</span>
                      {mensaje.adjuntos.map((ref) => (
                        // `<a>` y no `<Link>`: son descargas de la API.
                        <a
                          key={ref}
                          href={`/api/archivos/${ref}`}
                          className="font-medium text-neutral-900 underline"
                        >
                          {ref.split('/').pop()}
                        </a>
                      ))}
                    </p>
                  ) : null}

                  {mensaje.direccion === 'saliente' ? (
                    <div className="mt-2">
                      <BotonCopiar texto={mensaje.texto} etiqueta="Copiar el mensaje" />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* --- Registrar y corregir ------------------------------------------ */}
      {puedeEscribir ? (
        <Card>
          <CardContent className="flex flex-col gap-4">
            <FormularioEntrante
              obraId={obra.id}
              contactoId={contacto.id}
              proveedor={proveedor.nombre}
            />
            <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3">
              <h2 className="text-sm font-semibold text-neutral-900">Estado del contacto</h2>
              <AccionesEstado
                obraId={obra.id}
                contactoId={contacto.id}
                estadoActual={contacto.estado}
              />
            </div>
          </CardContent>
        </Card>
      ) : (
        <p className="rounded-md border border-neutral-300 bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          Con rol de solo lectura podés mirar el hilo, pero no registrar mensajes ni cambiar el
          estado.
        </p>
      )}
    </div>
  );
}
