import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { requireObra } from '@/lib/auth/guards';
import { HEADER_PATHNAME } from '@/middleware';
import type { TipoObra } from '@/types/domain';

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

/**
 * Las cuatro pantallas de la obra (PRD §8). Expediente, Cómputo y Bandeja las
 * construyen las tareas 6, 7 y 8: las solapas ya apuntan a su ruta definitiva,
 * sin páginas de relleno de por medio.
 */
const SOLAPAS = [
  { etiqueta: 'Tablero', segmento: '' },
  { etiqueta: 'Expediente', segmento: '/expediente' },
  { etiqueta: 'Cómputo', segmento: '/computo' },
  { etiqueta: 'Bandeja', segmento: '/bandeja' },
] as const;

function esSolapaActiva(pathname: string, href: string, base: string): boolean {
  if (href === base) return pathname === base;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Mete el nombre de la obra en el título de la solapa. Cada pantalla de adentro
 * aporta el suyo ("Expediente", "Cómputo"…) y termina en «Expediente · Casa
 * Belgrano · Compulsa»; el tablero, que no exporta título propio, cae en el
 * `default` y queda «Casa Belgrano · Compulsa».
 *
 * `requireObra` está memoizado por request, así que esto no agrega una consulta:
 * es la misma que hace el layout dos líneas más abajo.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ obraId: string }>;
}): Promise<Metadata> {
  const { obraId } = await params;
  const obra = await requireObra(obraId);
  return { title: { default: obra.nombre, template: `%s · ${obra.nombre} · Compulsa` } };
}

export default async function ObraLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ obraId: string }>;
}) {
  const { obraId } = await params;
  // Aislamiento RNF-4: la obra o es del estudio de la sesión, o es un 404.
  const obra = await requireObra(obraId);

  const base = `/obras/${obra.id}`;
  // Lo pone el middleware. Si faltara, ninguna solapa queda marcada — degrada.
  const pathname = (await headers()).get(HEADER_PATHNAME) ?? '';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link href="/obras" className="text-sm text-neutral-500 hover:text-neutral-900">
          ← Volver a obras
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">{obra.nombre}</h1>
          <Badge tone={TONO_TIPO[obra.tipo]}>{ETIQUETA_TIPO[obra.tipo]}</Badge>
          {obra.estado === 'archivada' ? <Badge tone="neutral">Archivada</Badge> : null}
        </div>
        <p className="text-sm text-neutral-600">
          {obra.zona} · Cómputo en {obra.moneda}
        </p>
      </div>

      <nav aria-label="Secciones de la obra" className="border-b border-neutral-200">
        <ul className="-mb-px flex flex-wrap gap-1">
          {SOLAPAS.map(({ etiqueta, segmento }) => {
            const href = `${base}${segmento}`;
            const activa = esSolapaActiva(pathname, href, base);
            return (
              <li key={etiqueta}>
                <Link
                  href={href}
                  aria-current={activa ? 'page' : undefined}
                  className={[
                    'inline-flex items-center border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                    activa
                      ? 'border-neutral-900 text-neutral-900'
                      : 'border-transparent text-neutral-600 hover:border-neutral-300 hover:text-neutral-900',
                  ].join(' ')}
                >
                  {etiqueta}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {children}
    </div>
  );
}
