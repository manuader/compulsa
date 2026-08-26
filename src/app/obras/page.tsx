import { desc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { getDb } from '@/db/client';
import { obras } from '@/db/schema';
import { requireUser } from '@/lib/auth/guards';
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

export default async function ObrasPage() {
  const { estudio } = await requireUser();
  const db = await getDb();

  const lista = await db
    .select()
    .from(obras)
    .where(eq(obras.estudioId, estudio.id))
    .orderBy(desc(obras.createdAt));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Obras</h1>
          <p className="text-sm text-neutral-600">{estudio.nombre}</p>
        </div>
        <Link href="/obras/nueva">
          <Button>Crear obra</Button>
        </Link>
      </div>

      {lista.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <p className="text-sm font-medium text-neutral-900">Todavía no cargaste ninguna obra.</p>
            <p className="text-sm text-neutral-600">
              Creá la primera y después subí la documentación para arrancar el cómputo.
            </p>
            <Link href="/obras/nueva">
              <Button>Crear la primera obra</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {lista.map((obra) => (
            <li key={obra.id}>
              <Link href={`/obras/${obra.id}`} className="block h-full">
                <Card className="h-full transition-colors hover:border-neutral-400">
                  <CardContent className="flex h-full flex-col gap-2">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="text-sm font-semibold text-neutral-900">{obra.nombre}</h2>
                      <Badge tone={TONO_TIPO[obra.tipo]}>{ETIQUETA_TIPO[obra.tipo]}</Badge>
                    </div>
                    <p className="text-sm text-neutral-600">{obra.zona}</p>
                    <p className="mt-auto pt-2 text-xs text-neutral-500">
                      Creada el {FECHA.format(obra.createdAt)}
                      {obra.estado === 'archivada' ? ' · Archivada' : ''}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
