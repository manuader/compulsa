import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { getDb } from '@/db/client';
import { getSession, type SesionActiva } from '@/lib/auth/session';
import { contarNoLeidas, listarNotificaciones } from '@/lib/plataforma/notificaciones';

import { salirAction } from './(auth)/actions';
import { Campanita, type NotificacionEnCampana } from './estudio/ui';
import './globals.css';

/**
 * `template` es lo que hace que la solapa del browser diga en qué pantalla
 * estás: cada página aporta su nombre y acá se le pega la marca. El layout de
 * `/obras/[obraId]` mete además el nombre de la obra en el medio, así dos obras
 * abiertas en dos solapas se distinguen sin cambiar de pestaña.
 */
export const metadata: Metadata = {
  title: { default: 'Compulsa', template: '%s · Compulsa' },
  description: 'Análisis documental, cómputo y compulsa de obra para estudios de arquitectura.',
};

/** Fecha corta para la campanita: el día alcanza para ubicar un aviso. */
const FECHA_CORTA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Lo que la campanita muestra: el contador de no leídas y las últimas diez.
 *
 * Va en el layout porque la campanita vive en el header de todas las pantallas.
 * Son dos queries por request sobre índices propios (`notificaciones_usuario_idx`)
 * y solo para sesiones abiertas: sin sesión no se consulta nada.
 */
async function avisosDelUsuario(sesion: SesionActiva | null) {
  if (!sesion) return { noLeidas: 0, items: [] as NotificacionEnCampana[] };

  const db = await getDb();
  const [noLeidas, ultimas] = await Promise.all([
    contarNoLeidas(db, sesion.usuario.id),
    listarNotificaciones(db, sesion.usuario.id),
  ]);

  return {
    noLeidas,
    items: ultimas.map((aviso) => ({
      id: aviso.id,
      titulo: aviso.titulo,
      cuerpo: aviso.cuerpo,
      link: aviso.link,
      leida: aviso.leida,
      at: FECHA_CORTA.format(aviso.createdAt),
    })),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // El layout envuelve también a `/login` y `/register`: sin sesión no es un
  // error, es el estado normal de esas pantallas.
  const sesion = await getSession();
  const avisos = await avisosDelUsuario(sesion);

  return (
    <html lang="es-AR">
      <body className="min-h-screen">
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-8 px-6">
            <Link
              href="/obras"
              className="text-base font-semibold tracking-tight text-neutral-900"
            >
              Compulsa
            </Link>
            <nav
              aria-label="Navegación principal"
              className="flex flex-1 items-center gap-4 text-sm text-neutral-600"
            >
              {sesion ? (
                <>
                  <Link href="/obras" className="hover:text-neutral-900">
                    Obras
                  </Link>
                  <Link href="/proveedores" className="hover:text-neutral-900">
                    Proveedores
                  </Link>
                  <Link href="/estudio" className="hover:text-neutral-900">
                    Estudio
                  </Link>
                  <div className="ml-auto flex items-center gap-3">
                    <Campanita noLeidas={avisos.noLeidas} items={avisos.items} />
                    <span className="hidden text-neutral-500 sm:inline">
                      {sesion.estudio.nombre} · {sesion.usuario.email}
                    </span>
                    <form action={salirAction}>
                      <Button type="submit" variant="ghost" size="sm">
                        Salir
                      </Button>
                    </form>
                  </div>
                </>
              ) : (
                <div className="ml-auto flex items-center gap-4">
                  <Link href="/login" className="hover:text-neutral-900">
                    Entrar
                  </Link>
                  <Link href="/register" className="font-medium text-neutral-900 hover:underline">
                    Registrá tu estudio
                  </Link>
                </div>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
