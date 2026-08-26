import { and, count, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { getDb } from '@/db/client';
import { deducciones } from '@/db/schema';
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
 * Las pantallas de la obra (PRD §8). Las solapas apuntan siempre a su ruta
 * definitiva, sin páginas de relleno de por medio.
 *
 * «Deducciones» es la única que lleva contador: las otras cuatro son lugares a
 * los que se va, y esta es una **cola de trabajo** —lo que el motor propuso y
 * espera una decisión—. Sin el número, nadie entra a mirar si hay algo.
 */
const SOLAPAS = [
  { etiqueta: 'Tablero', segmento: '' },
  { etiqueta: 'Expediente', segmento: '/expediente' },
  { etiqueta: 'Cómputo', segmento: '/computo' },
  { etiqueta: 'Bandeja', segmento: '/bandeja' },
  { etiqueta: 'Deducciones', segmento: '/deducciones' },
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

  const db = await getDb();
  const [propuestas] = await db
    .select({ total: count() })
    .from(deducciones)
    .where(and(eq(deducciones.obraId, obra.id), eq(deducciones.estado, 'propuesta')));
  const pendientes = propuestas?.total ?? 0;

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

      <nav
        aria-label="Secciones de la obra"
        className="flex flex-wrap items-end justify-between gap-2 border-b border-neutral-200"
      >
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
                  {/* El contador solo aparece si hay algo que decidir: un «0»
                      permanente al lado de la solapa deja de leerse a la semana. */}
                  {segmento === '/deducciones' && pendientes > 0 ? (
                    <Badge tone="info" className="ml-2">
                      {pendientes}
                    </Badge>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Fuera de la lista de solapas a propósito: no es una quinta pantalla
            del trabajo diario, es donde se cambian los datos y se archiva. */}
        <Link
          href={`${base}/config`}
          aria-current={esSolapaActiva(pathname, `${base}/config`, base) ? 'page' : undefined}
          className={[
            '-mb-px inline-flex items-center gap-1 border-b-2 px-3 py-2 text-sm transition-colors',
            esSolapaActiva(pathname, `${base}/config`, base)
              ? 'border-neutral-900 font-medium text-neutral-900'
              : 'border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-900',
          ].join(' ')}
        >
          <span aria-hidden="true">⚙</span> Configuración
        </Link>
      </nav>

      {/* La obra archivada se navega igual: el aviso explica por qué no aparece
          en el listado, no bloquea nada. */}
      {obra.estado === 'archivada' ? (
        <p className="rounded-md border border-neutral-300 bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          Obra archivada — no aparece en el listado y está para consulta.{' '}
          <Link
            href={`${base}/config#zona-de-riesgo`}
            className="font-medium text-neutral-900 underline"
          >
            Desarchivala o eliminala definitivamente
          </Link>{' '}
          desde la configuración.
        </p>
      ) : null}

      {children}
    </div>
  );
}
