import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { getSession } from '@/lib/auth/session';

import { salirAction } from './(auth)/actions';
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  // El layout envuelve también a `/login` y `/register`: sin sesión no es un
  // error, es el estado normal de esas pantallas.
  const sesion = await getSession();

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
                  <div className="ml-auto flex items-center gap-3">
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
