import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Compulsa',
  description: 'Análisis documental, cómputo y compulsa de obra para estudios de arquitectura.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
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
            {/* Slot de navegación: lo completa el shell de sesión. */}
            <nav aria-label="Navegación principal" className="flex flex-1 items-center gap-4 text-sm text-neutral-600" />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
