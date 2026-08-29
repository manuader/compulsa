/**
 * Precios de referencia del estudio (§5.6).
 *
 * Server Component: lee la lista con `getDb()` y **formatea los números acá**
 * (`src/app/CLAUDE.md`: si un número tiene que salir en es-AR, se formatea en
 * el server, no con el `toString()` de JS). La interactividad —alta, edición,
 * borrado y preview del CSV— vive en `./ui`.
 *
 * La pantalla se ve con cualquier rol: saber con qué precio se está costeando
 * la obra no es una mutación. Las acciones se dibujan solo para colaborador o
 * titular, y el core las rechaza igual si alguien las invoca de otro lado
 * (RF-1201).
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getDb } from '@/db/client';
import { requireUser } from '@/lib/auth/guards';
import { formatearMonto } from '@/lib/compulsa/comparativa';
import { esRolSuficiente } from '@/lib/plataforma/roles';
import { listarPrecios } from '@/lib/precios/gestion';

import { FormularioPrecio, ImportadorCsvPrecios, TablaPrecios, type PrecioVista } from './ui';

export const metadata: Metadata = { title: 'Precios del estudio' };

/** `2026-08-10` → `10/08/2026`, sin pasar por `Date` (que corre la fecha por zona horaria). */
function fechaEsAr(iso: string): string {
  const [anio, mes, dia] = iso.split('-');
  return dia === undefined ? iso : `${dia}/${mes}/${anio}`;
}

/**
 * El precio como hay que meterlo en el input: coma decimal y **sin separador de
 * miles**.
 *
 * `formatearImporte` (el de la tabla) escribe `145.000`, y `parsearPrecio` lee
 * un separador solo, una sola vez, como el decimal —la convención es-AR—, así
 * que abrir el diálogo de edición de un precio de 145.000 y guardarlo sin
 * tocarlo lo dejaría en 145. Con `145000` no hay nada que interpretar.
 */
function precioEditable(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

export default async function PreciosEstudioPage() {
  const { usuario, estudio } = await requireUser();
  const db = await getDb();
  const filas = await listarPrecios(db, estudio.id);
  const puedeGestionar = esRolSuficiente(usuario, 'colaborador');

  const precios: PrecioVista[] = filas.map((fila) => ({
    id: fila.id,
    claveItem: fila.claveItem,
    descripcion: fila.descripcion,
    unidad: fila.unidad,
    precioFormateado: formatearMonto(fila.moneda, fila.precio),
    precioEditable: precioEditable(fila.precio),
    moneda: fila.moneda,
    fecha: fila.fecha,
    fechaFormateada: fechaEsAr(fila.fecha),
    origen: fila.origen,
  }));

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Precios de referencia
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-neutral-600">
          La lista con la que el cómputo estima el costo de cada ítem. Manda el precio que hayas
          puesto a mano en la planilla; después esta lista; y si el ítem no está acá, el índice de
          precios que arman tus propias compulsas. Lo que no tiene ninguna de las tres se muestra sin
          precio: el sistema no inventa un número.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>La lista del estudio</CardTitle>
        </CardHeader>
        <CardContent>
          <TablaPrecios precios={precios} puedeGestionar={puedeGestionar} />
        </CardContent>
      </Card>

      {puedeGestionar ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Cargar un precio</CardTitle>
            </CardHeader>
            <CardContent>
              <FormularioPrecio />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Importar una lista</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-neutral-600">
                Copiá las filas de tu Excel y pegalas acá. Antes de guardar nada vas a ver qué entra
                y qué línea tiene un problema.
              </p>
              <ImportadorCsvPrecios />
            </CardContent>
          </Card>
        </>
      ) : (
        <p className="text-sm text-neutral-600">
          Tu rol es de solo lectura: la lista de precios la cargan los colaboradores y el titular del
          estudio.{' '}
          <Link href="/estudio" className="font-medium underline">
            Volver al estudio
          </Link>
          .
        </p>
      )}
    </div>
  );
}
