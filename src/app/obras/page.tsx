import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { estilosBoton } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { getDb } from '@/db/client';
import type { Obra } from '@/db/schema';
import { requireUser } from '@/lib/auth/guards';
import { listarObras } from '@/lib/obras/gestion';
import type { TipoObra } from '@/types/domain';

// Local a propósito: un `page.tsx` solo debería exportar lo que el App Router
// espera (default, metadata…). El tablero repite el par de mapas.
const ETIQUETA_TIPO: Record<TipoObra, string> = {
  nueva: 'Obra nueva',
  reforma: 'Reforma',
  ampliacion: 'Ampliación',
};

const TONO_TIPO: Record<TipoObra, BadgeTone> = {
  nueva: 'info',
  reforma: 'warn',
  ampliacion: 'neutral',
};

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export const metadata: Metadata = { title: 'Obras' };

/** Concordancia de número: "1 obra archivada" y no "1 obras archivadas". */
function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

function TarjetaObra({ obra }: { obra: Obra }) {
  const archivada = obra.estado === 'archivada';
  // Las dos acciones de una obra archivada viven en su configuración: acá son
  // links (no botones) porque navegan, y quedan FUERA del `<Link>` de la tarjeta
  // — un `<a>` adentro de otro `<a>` el HTML no lo admite.
  const config = `/obras/${obra.id}/config#zona-de-riesgo`;

  return (
    <Card className={`flex h-full flex-col ${archivada ? 'bg-neutral-50' : ''}`}>
      <Link href={`/obras/${obra.id}`} className="block flex-1">
        <CardContent className="flex h-full flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-sm font-semibold text-neutral-900">{obra.nombre}</h2>
            <div className="flex flex-none flex-wrap justify-end gap-1">
              <Badge tone={TONO_TIPO[obra.tipo]}>{ETIQUETA_TIPO[obra.tipo]}</Badge>
              {archivada ? <Badge tone="neutral">Archivada</Badge> : null}
            </div>
          </div>
          <p className="text-sm text-neutral-600">{obra.zona}</p>
          <p className="mt-auto pt-2 text-xs text-neutral-500">
            Creada el {FECHA.format(obra.createdAt)}
          </p>
        </CardContent>
      </Link>

      {archivada ? (
        <CardFooter className="justify-end gap-3 text-xs">
          <Link href={config} className="font-medium text-neutral-700 underline hover:text-neutral-900">
            Desarchivar
          </Link>
          <Link href={config} className="font-medium text-red-700 underline hover:text-red-800">
            Eliminar definitivamente
          </Link>
        </CardFooter>
      ) : null}
    </Card>
  );
}

export default async function ObrasPage({
  searchParams,
}: {
  searchParams: Promise<{ archivadas?: string }>;
}) {
  const { estudio } = await requireUser();
  const { archivadas: parametro } = await searchParams;
  // `?archivadas=1`. Cualquier otro valor es "no": el default de la pantalla son
  // las obras vivas, archivar tiene que sacar la obra de la vista.
  const verArchivadas = parametro === '1';

  const listado = await listarObras(await getDb(), estudio.id, { archivadas: verArchivadas });

  const vacia = listado.obras.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
            {verArchivadas ? 'Obras archivadas' : 'Obras'}
          </h1>
          <p className="text-sm text-neutral-600">{estudio.nombre}</p>
        </div>
        {/* El link se viste de botón: un `<Button>` acá dejaría un `<button>`
            adentro de un `<a>`, que el HTML no admite. */}
        <Link href="/obras/nueva" className={estilosBoton()}>
          Crear obra
        </Link>
      </div>

      {/* El contador es real: si no hay ninguna archivada, no se ofrece verlas. */}
      {verArchivadas ? (
        <Link href="/obras" className="text-sm font-medium text-neutral-700 underline hover:text-neutral-900">
          ← Volver a las obras activas ({listado.activas})
        </Link>
      ) : listado.archivadas > 0 ? (
        <Link
          href="/obras?archivadas=1"
          className="text-sm font-medium text-neutral-700 underline hover:text-neutral-900"
        >
          Ver archivadas ({listado.archivadas})
        </Link>
      ) : null}

      {vacia ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            {verArchivadas ? (
              <>
                <p className="text-sm font-medium text-neutral-900">
                  No tenés ninguna obra archivada.
                </p>
                <p className="text-sm text-neutral-600">
                  Cuando termines una obra, archivala desde su configuración: sale del listado y no
                  se pierde nada.
                </p>
                <Link href="/obras" className={estilosBoton('secondary')}>
                  Volver a las obras activas
                </Link>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-neutral-900">
                  Todavía no cargaste ninguna obra.
                </p>
                <p className="text-sm text-neutral-600">
                  Creá la primera y después subí la documentación para arrancar el cómputo.
                </p>
                <Link href="/obras/nueva" className={estilosBoton()}>
                  Crear la primera obra
                </Link>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {verArchivadas ? (
            <p className="text-sm text-neutral-600">
              {plural(listado.archivadas, 'obra archivada', 'obras archivadas')}. Se pueden abrir y
              consultar; para volver a trabajarlas, desarchivalas.
            </p>
          ) : null}
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {listado.obras.map((obra) => (
              <li key={obra.id}>
                <TarjetaObra obra={obra} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
