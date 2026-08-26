/**
 * Alta de un proveedor a mano.
 *
 * La página es un Server Component —así puede exportar su `metadata`, que es lo
 * que hace que la solapa diga en qué pantalla estás— y el formulario, que es lo
 * único con estado, vive en `../ui`.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { estilosBoton } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/guards';

import { FormularioNuevoProveedor } from '../ui';

export const metadata: Metadata = { title: 'Agregar proveedor' };

function SoloLectura() {
  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-8">
          <p className="text-sm font-medium text-neutral-900">
            Tu rol es de solo lectura: la agenda de proveedores la gestionan los colaboradores y el
            titular del estudio.
          </p>
          <Link href="/proveedores" className={estilosBoton('secondary')}>
            Volver a la agenda
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export default async function NuevoProveedorPage() {
  // Sin sesión no hay estudio al que sumarle un proveedor: el guard va acá y no
  // solo en la action, para que la pantalla ni se dibuje.
  const { usuario } = await requireUser();

  // Un `lectura` que entra por la URL ve por qué no puede, en vez de llenar un
  // formulario que la action le va a rechazar (RF-1201; el que manda es el core).
  if (usuario.rol === 'lectura') return <SoloLectura />;

  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>Agregar proveedor</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-neutral-600">
            Con el rubro y la zona alcanza para que aparezca en las shortlists. El teléfono y el
            mail son los canales por los que se le va a pedir presupuesto.
          </p>
          <FormularioNuevoProveedor />
        </CardContent>
      </Card>
    </div>
  );
}
