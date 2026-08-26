/**
 * Armado de una compulsa (PRD §8.6): un wizard en **una sola página**.
 *
 * Los cinco pasos están todos a la vista porque son una sola decisión partida en
 * cinco: a quién le pido qué, con qué condiciones y con qué margen para
 * negociar. Un wizard de cinco pantallas obligaría a ir y volver para comparar
 * el ítem con el proveedor.
 *
 * El paso 1 (elegir rubro) es un `<form method="get">` y viaja en la URL: la
 * pantalla se puede compartir, sobrevive al F5 y el preview del snapshot lo
 * arma el server, que es el único que sabe qué ítems están activos. Los pasos 2
 * a 5 son una isla cliente (`FormularioNuevaCompulsa`).
 */
import { and, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { getDb } from '@/db/client';
import { computoRubros } from '@/db/schema';
import { requireObra, requireUser } from '@/lib/auth/guards';
import { formatearCantidad } from '@/lib/computo/unidades';
import { esRolSuficiente } from '@/lib/plataforma/roles';
import { contactosDe } from '@/lib/proveedores/gestion';
import type { GrupoShortlist } from '@/lib/proveedores/shortlist';
import { PLANTILLAS } from '@/lib/rubros/index';
import { RUBROS, type RubroId } from '@/types/domain';

import { armarSeleccionProveedoresCore, previewRubroCore } from '../actions';
import { FormularioNuevaCompulsa, type ProveedorOfrecido } from '../ui';

export const metadata: Metadata = { title: 'Nueva compulsa' };

const ETIQUETA_GRUPO: Record<GrupoShortlist, string> = {
  red_con_historial: 'De la red, con historial',
  red: 'De la red',
  zona: 'De la zona',
  resto: 'Resto de la agenda',
};

const TONO_GRUPO: Record<GrupoShortlist, BadgeTone> = {
  red_con_historial: 'ok',
  red: 'info',
  zona: 'warn',
  resto: 'neutral',
};

function esRubro(valor: string | null): valor is RubroId {
  return valor !== null && (RUBROS as readonly string[]).includes(valor);
}

function primerParametro(valor: string | string[] | undefined): string | null {
  if (Array.isArray(valor)) return valor[0] ?? null;
  return valor ?? null;
}

export default async function NuevaCompulsaPage({
  params,
  searchParams,
}: {
  params: Promise<{ obraId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ obraId }, query] = await Promise.all([params, searchParams]);
  const obra = await requireObra(obraId);
  const { usuario, estudio } = await requireUser();
  const db = await getDb();

  const aprobados = await db
    .select({ rubro: computoRubros.rubro })
    .from(computoRubros)
    .where(and(eq(computoRubros.obraId, obra.id), eq(computoRubros.estado, 'aprobado')));

  const base = `/obras/${obra.id}`;
  const pedido = primerParametro(query.rubro);
  const rubro =
    esRubro(pedido) && aprobados.some((fila) => fila.rubro === pedido) ? pedido : null;

  const puedeLanzar = esRolSuficiente(usuario, 'titular');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link href={`${base}/compulsas`} className="text-sm text-neutral-500 hover:text-neutral-900">
          ← Volver a compulsas
        </Link>
        <h1 className="text-base font-semibold text-neutral-900">Nueva compulsa</h1>
      </div>

      {/* --- 1. Rubro ------------------------------------------------------ */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-900">1 · Rubro</h2>

          {aprobados.length === 0 ? (
            <p className="text-sm text-neutral-700">
              Ningún rubro está aprobado todavía. Lo que se manda es lo que se aprobó (RF-701):{' '}
              <Link href={`${base}/computo`} className="font-medium text-neutral-900 underline">
                aprobá un rubro en el cómputo
              </Link>{' '}
              y volvé.
            </p>
          ) : (
            // El paso 1 viaja por la URL con un `<form method="get">`: la
            // pantalla se comparte, sobrevive al F5 y no necesita JavaScript.
            <form method="get" className="flex flex-wrap items-end gap-2">
              <Select name="rubro" label="Rubro aprobado" defaultValue={rubro ?? ''}>
                <option value="">Elegí un rubro…</option>
                {aprobados.map((fila) => (
                  <option key={fila.rubro} value={fila.rubro}>
                    {PLANTILLAS[fila.rubro].nombre}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="secondary">
                Ver los ítems
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {rubro === null ? null : (
        <PasosDelRubro
          obraId={obra.id}
          estudioId={estudio.id}
          zona={obra.zona}
          rubro={rubro}
          puedeLanzar={puedeLanzar}
        />
      )}
    </div>
  );
}

async function PasosDelRubro({
  obraId,
  estudioId,
  zona,
  rubro,
  puedeLanzar,
}: {
  obraId: string;
  estudioId: string;
  zona: string;
  rubro: RubroId;
  puedeLanzar: boolean;
}) {
  const db = await getDb();
  const [preview, seleccion] = await Promise.all([
    previewRubroCore(db, estudioId, obraId, rubro),
    armarSeleccionProveedoresCore(db, estudioId, rubro, zona),
  ]);

  const proveedores: ProveedorOfrecido[] = seleccion.rankeados.map((rankeado) => {
    const canales = contactosDe(rankeado.proveedor);
    const contacto = [canales.contacto, canales.telefono, canales.email]
      .filter((valor): valor is string => !!valor)
      .join(' · ');
    return {
      id: rankeado.proveedor.id,
      nombre: rankeado.proveedor.nombre,
      grupo: ETIQUETA_GRUPO[rankeado.grupo],
      grupoTono: TONO_GRUPO[rankeado.grupo],
      zona: rankeado.proveedor.zona,
      cotizaciones: rankeado.cotizaciones,
      contacto: contacto === '' ? null : contacto,
    };
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Aviso RF-701: se ve ANTES de lanzar, no después del error. */}
      {preview.aviso?.tipo === 'cambio' ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong className="font-medium">El cómputo cambió</strong> desde la compulsa v
          {preview.aviso.version}: esto crea la versión {preview.aviso.versionNueva} y cierra la
          anterior. Lo que se pidió antes queda visible, no se corrige.{' '}
          <Link
            href={`/obras/${obraId}/compulsas/${preview.aviso.compulsaId}`}
            className="font-medium underline"
          >
            Ver la anterior
          </Link>
        </p>
      ) : null}
      {preview.aviso?.tipo === 'vigente' ? (
        <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          Ya hay una compulsa de este rubro en curso (v{preview.aviso.version}) con el mismo
          cómputo. Sumale proveedores desde{' '}
          <Link
            href={`/obras/${obraId}/compulsas/${preview.aviso.compulsaId}`}
            className="font-medium underline"
          >
            su pantalla
          </Link>{' '}
          en vez de lanzar otra: una compulsa nueva del mismo cómputo se rechaza. Si cambiaste
          especificaciones o condiciones, decide el server — esta comparación mira los ítems, no el
          hash.
        </p>
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">
              Lo que se va a congelar · {PLANTILLAS[rubro].nombre}
            </h2>
            <Badge tone="neutral">
              {preview.items.length} {preview.items.length === 1 ? 'ítem' : 'ítems'} · el hash se
              calcula al lanzar
            </Badge>
          </div>
          <p className="text-xs text-neutral-600">
            Son los ítems activos del cómputo aprobado, tal cual van a viajar en el pedido. No se
            editan desde acá: si algo está mal, el lugar es la planilla.
          </p>

          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Ítem</TableHeaderCell>
                <TableHeaderCell numeric>Cantidad</TableHeaderCell>
                <TableHeaderCell>Presentación</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {preview.items.map((item) => (
                <TableRow key={item.claveItem}>
                  <TableCell>
                    <span className="block text-neutral-900">{item.descripcion}</span>
                    <span className="block font-mono text-xs text-neutral-500">
                      {item.claveItem}
                    </span>
                  </TableCell>
                  <TableCell numeric>{formatearCantidad(item.cantidad, item.unidad)}</TableCell>
                  <TableCell>{item.presentacion}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <FormularioNuevaCompulsa
        obraId={obraId}
        rubro={rubro}
        rubroNombre={PLANTILLAS[rubro].nombre}
        items={preview.items.map((item) => ({
          claveItem: item.claveItem,
          descripcion: item.descripcion,
          cantidad: formatearCantidad(item.cantidad, item.unidad),
          presentacion: item.presentacion,
        }))}
        condiciones={preview.condiciones}
        mandato={preview.mandato}
        proveedores={proveedores}
        excluidos={seleccion.excluidos}
        puedeLanzar={puedeLanzar}
        motivoSinPermiso={
          puedeLanzar ? null : 'Lanzar una compulsa es del titular del estudio (RF-1201).'
        }
      />
    </div>
  );
}
