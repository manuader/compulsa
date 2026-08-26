/**
 * Una compulsa por dentro (PRD §8.6): qué se pidió, a quién, y en qué anda cada
 * proveedor.
 *
 * ## Tres decisiones de esta pantalla
 *
 * 1. **El hilo se lee con `leerHilos`** (P5): una sola consulta de mensajes para
 *    todos los contactos, no una por proveedor. Las banderas de sustitución sí
 *    van de a una (`banderasDeContacto`), y es a propósito: son dos consultas por
 *    proveedor y una compulsa tiene un puñado. Si algún día son cincuenta, el
 *    batch va en `threads.ts`, no acá.
 * 2. **El aviso de «sin respuesta» es una consulta, no un cron.** Se calcula al
 *    abrir la pantalla. La notificación al titular se escribe **acá, durante el
 *    render**, la primera vez que se detecta: es la única forma sin un scheduler,
 *    y es segura porque `notificarSinRespuestaCore` deduplica por link (abrir la
 *    pantalla diez veces escribe una sola notificación). No se llama
 *    `revalidatePath` durante el render, que sí sería un error.
 * 3. **El cuerpo crudo del mensaje no se muestra nunca.** `leerHilos` devuelve el
 *    texto sin el bloque de adjuntos y las refs por separado (P5): el botón
 *    «Copiar» copia lo que el proveedor tiene que leer, y los recortes son links
 *    de descarga.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { BotonCopiar } from '@/components/ui/boton-copiar';
import { estilosBoton } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { getDb } from '@/db/client';
import { compulsas, cotizaciones } from '@/db/schema';
import { requireObra, requireUser } from '@/lib/auth/guards';
import { formatearCantidad, formatearNumero } from '@/lib/computo/unidades';
import {
  banderasDeContacto,
  CompulsaNoEncontradaError,
  leerHilos,
  requireCompulsaCore,
} from '@/lib/outreach/threads';
import { esRolSuficiente } from '@/lib/plataforma/roles';
import { PLANTILLAS } from '@/lib/rubros/index';
import type { EstadoCompulsa, EstadoContacto } from '@/types/domain';

import { detectarSinRespuestaCore, notificarSinRespuestaCore } from '../actions';
import { PanelContacto, type ContactoVista, type CotizacionVista } from '../ui';

export const metadata: Metadata = { title: 'Compulsa' };

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
  pendiente: 'Por mandar',
  contactado: 'Contactado',
  cotizo: 'Cotizó',
  negociando: 'Negociando',
  cerrado: 'Cerrado',
  sin_respuesta: 'Sin respuesta',
};

const ETIQUETA_PALANCA: Record<string, string> = {
  volumen: 'volumen',
  plazo_pago: 'plazo de pago',
  fecha: 'fecha de entrega',
  adjudicacion_inmediata: 'adjudicación inmediata',
};

const MOMENTO = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Argentina/Buenos_Aires',
});

const FECHA = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'short',
  timeZone: 'America/Argentina/Buenos_Aires',
});

/** Bloque de la cabecera. Presentacional puro: no necesita ser cliente. */
function Dato({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium tracking-wide text-neutral-500 uppercase">{titulo}</span>
      <span className="text-sm text-neutral-900">{children}</span>
    </div>
  );
}

export default async function CompulsaPage({
  params,
}: {
  params: Promise<{ obraId: string; compulsaId: string }>;
}) {
  const { obraId, compulsaId } = await params;
  const obra = await requireObra(obraId);
  const { usuario, estudio } = await requireUser();
  const db = await getDb();

  let compulsa;
  try {
    ({ compulsa } = await requireCompulsaCore(db, estudio.id, compulsaId));
  } catch (error) {
    if (error instanceof CompulsaNoEncontradaError) notFound();
    throw error;
  }
  // La compulsa es de una obra del estudio, pero puede no ser la de la URL.
  if (compulsa.obraId !== obra.id) notFound();

  const hilos = await leerHilos(db, estudio.id, compulsa.id);
  const contactoIds = hilos.map((hilo) => hilo.contexto.contacto.id);

  const [cotizadas, banderasPorContacto, avisos, ultima] = await Promise.all([
    contactoIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(cotizaciones)
          .where(inArray(cotizaciones.contactoId, contactoIds))
          .orderBy(desc(cotizaciones.createdAt)),
    Promise.all(contactoIds.map((id) => banderasDeContacto(db, estudio.id, id))),
    detectarSinRespuestaCore(db, estudio.id, obra.id, new Date()),
    db
      .select({ id: compulsas.id, version: compulsas.version })
      .from(compulsas)
      .where(eq(compulsas.obraId, obra.id))
      .orderBy(desc(compulsas.version))
      .limit(1),
  ]);

  const puedeEscribir = esRolSuficiente(usuario, 'colaborador');

  const deEstaCompulsa = avisos.filter((aviso) => aviso.compulsaId === compulsa.id);
  // Ver el encabezado del archivo: escritura idempotente durante el render, y
  // **solo si el que mira puede escribir** — el núcleo lo decide con el actor,
  // que va entero (rol y `activo` incluidos), no con el estudio pelado.
  await notificarSinRespuestaCore(
    db,
    {
      usuarioId: usuario.id,
      email: usuario.email,
      rol: usuario.rol,
      activo: usuario.activo,
      estudioId: estudio.id,
    },
    obra.id,
    deEstaCompulsa,
  );
  const diasDeSilencio = new Map(deEstaCompulsa.map((aviso) => [aviso.contactoId, aviso.dias]));
  const base = `/obras/${obra.id}`;
  const condiciones = compulsa.condicionesJson;
  const mandato = compulsa.mandatoJson;

  const contactos: ContactoVista[] = hilos.map((hilo, indice) => {
    const contacto = hilo.contexto.contacto;
    const banderas = banderasPorContacto[indice] ?? [];
    const suyas = cotizadas.filter((fila) => fila.contactoId === contacto.id);

    // `registrarEnvio` firma el borrador **más viejo**, uno por llamada: el
    // botón se ofrece solo en ese, para que la pantalla no prometa un orden que
    // el core no tiene.
    const proximo = hilo.mensajes.find((mensaje) => mensaje.estado === 'pendiente_envio_manual');

    return {
      id: contacto.id,
      proveedor: hilo.contexto.proveedor.nombre,
      estado: contacto.estado,
      estadoEtiqueta: ETIQUETA_CONTACTO[contacto.estado],
      pendientes: hilo.pendientes,
      sinRespuestaDias: diasDeSilencio.get(contacto.id) ?? null,
      banderas: banderas.map((bandera) => ({
        cotizacionId: bandera.cotizacionId,
        claveItem: bandera.claveItem,
        nota: bandera.nota,
      })),
      cotizaciones: suyas.map(
        (fila): CotizacionVista => ({
          id: fila.id,
          fecha: FECHA.format(fila.createdAt),
          total: fila.total === null ? null : formatearNumero(fila.total, 2),
          tieneTotal: fila.total !== null,
          moneda: fila.moneda,
          score: fila.scoreFidelidad === null ? null : `${Math.round(fila.scoreFidelidad * 100)}%`,
          incluyeIva: fila.incluyeIva,
          validezDias: fila.validezDias,
          plazoDias: fila.plazoDias,
          formaPago: fila.formaPago,
          lineas: fila.lineasJson.length,
          sustituciones: banderas.filter((bandera) => bandera.cotizacionId === fila.id).length,
        }),
      ),
      mensajes: hilo.mensajes.map((mensaje) => ({
        id: mensaje.id,
        direccion: mensaje.direccion,
        estado: mensaje.estado,
        texto: mensaje.texto,
        fecha: MOMENTO.format(mensaje.at),
        esProximoEnvio: mensaje.id === proximo?.id,
        adjuntos: mensaje.adjuntos.map((ref) => ({
          ref,
          nombre: ref.split('/').pop() ?? 'recorte.pdf',
        })),
      })),
    };
  });

  const esLaUltima = ultima[0]?.id === compulsa.id;
  const textoDelPedido =
    hilos[0]?.mensajes.find((mensaje) => mensaje.direccion === 'saliente')?.texto ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link href={`${base}/compulsas`} className="text-sm text-neutral-500 hover:text-neutral-900">
          ← Volver a compulsas
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold text-neutral-900">
            {PLANTILLAS[compulsa.rubro].nombre}
          </h1>
          <Badge tone="neutral">v{compulsa.version}</Badge>
          <Badge tone={TONO_ESTADO[compulsa.estado]}>{ETIQUETA_ESTADO[compulsa.estado]}</Badge>
        </div>
      </div>

      {/* --- Cabecera ------------------------------------------------------ */}
      <Card>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Dato titulo="Lanzada">{FECHA.format(compulsa.createdAt)}</Dato>
          <Dato titulo="Hash del snapshot (RF-701)">
            <span className="font-mono text-xs" title={compulsa.snapshotHash}>
              {compulsa.snapshotHash.slice(0, 16)}…
            </span>
          </Dato>
          <Dato titulo="Ítems pedidos">{compulsa.itemsJson.length}</Dato>
          <Dato titulo="Proveedores">{contactos.length}</Dato>

          <Dato titulo="Condiciones">
            IVA discriminado
            {condiciones.separarManoObraMateriales ? ', MO y materiales separados' : ''}, validez{' '}
            {condiciones.validezMinimaDias} días
            {condiciones.plazoEntregaDias === null
              ? ''
              : `, entrega en ${condiciones.plazoEntregaDias} días`}
            {condiciones.notas ? `. ${condiciones.notas}` : ''}
          </Dato>
          <Dato titulo="Mandato de negociación">
            {mandato === null
              ? 'Sin negociación automática.'
              : `Buscar ${formatearNumero(mandato.objetivoMejoraPct)}% de mejora, hasta ${mandato.maxRondas} rondas` +
                (mandato.palancas.length === 0
                  ? ', sin palancas.'
                  : `, con ${mandato.palancas.map((palanca) => ETIQUETA_PALANCA[palanca] ?? palanca).join(' y ')}.`)}
          </Dato>
        </CardContent>
      </Card>

      {/* --- Lo que se pidió ---------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">Lo que se pidió</h2>
            <div className="flex flex-wrap items-center gap-2">
              {textoDelPedido ? (
                <BotonCopiar texto={textoDelPedido} etiqueta="Copiar el pedido" />
              ) : null}
              {esLaUltima && compulsa.estado === 'lanzada' ? (
                <Link
                  href={`${base}/compulsas/nueva?rubro=${compulsa.rubro}`}
                  className={estilosBoton('ghost', 'sm')}
                  title="Si el cómputo cambió, esto crea la versión siguiente y cierra esta."
                >
                  Recompulsar
                </Link>
              ) : null}
            </div>
          </div>

          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Ítem</TableHeaderCell>
                <TableHeaderCell numeric>Cantidad</TableHeaderCell>
                <TableHeaderCell>Presentación</TableHeaderCell>
                <TableHeaderCell>No sustituible</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {compulsa.itemsJson.map((item) => (
                <TableRow key={item.claveItem}>
                  <TableCell>
                    <span className="block text-neutral-900">{item.descripcion}</span>
                    <span className="block font-mono text-xs text-neutral-500">
                      {item.claveItem}
                    </span>
                  </TableCell>
                  <TableCell numeric>{formatearCantidad(item.cantidad, item.unidad)}</TableCell>
                  <TableCell>{item.presentacion}</TableCell>
                  <TableCell>
                    {Object.entries(item.specsCriticas).length === 0
                      ? '—'
                      : Object.entries(item.specsCriticas)
                          .map(([spec, valor]) => `${spec}: ${valor}`)
                          .join(', ')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* --- Proveedor por proveedor -------------------------------------- */}
      <h2 className="text-sm font-semibold text-neutral-900">Proveedores</h2>
      {contactos.length === 0 ? (
        <p className="rounded-lg border border-neutral-200 bg-white px-4 py-6 text-center text-sm text-neutral-600">
          Esta compulsa no tiene proveedores cargados.
        </p>
      ) : (
        contactos.map((contacto) => (
          <PanelContacto
            key={contacto.id}
            obraId={obra.id}
            contacto={contacto}
            puedeEscribir={puedeEscribir}
          />
        ))
      )}
    </div>
  );
}
