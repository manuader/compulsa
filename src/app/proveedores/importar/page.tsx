/**
 * Import de la agenda desde un CSV pegado a mano (RF-801).
 *
 * Server Component por la `metadata`; el pegar → previsualizar → confirmar vive
 * en `ImportadorCsv` (`../ui`), que es cliente porque el preview se calcula
 * mientras se escribe.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { estilosBoton } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/guards';

import { ImportadorCsv } from '../ui';

export const metadata: Metadata = { title: 'Importar proveedores' };

export default async function ImportarProveedoresPage() {
  const { usuario } = await requireUser();

  // Igual que en el alta: el rol se ve antes de pegar 200 líneas de CSV.
  if (usuario.rol === 'lectura') {
    return (
      <div className="mx-auto max-w-xl">
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <p className="text-sm font-medium text-neutral-900">
              Tu rol es de solo lectura: la agenda de proveedores la gestionan los colaboradores y
              el titular del estudio.
            </p>
            <Link href="/proveedores" className={estilosBoton('secondary')}>
              Volver a la agenda
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Importar proveedores</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-neutral-600">
            Copiá las filas de tu Excel y pegalas acá. Antes de guardar nada vas a ver qué entra y
            qué línea tiene un problema.
          </p>
          <ImportadorCsv />
        </CardContent>
      </Card>
    </div>
  );
}
