/**
 * Solo existe por el `metadata`: `page.tsx` es un Client Component (el form usa
 * `useActionState`) y desde ahí no se puede exportar metadata.
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Entrar' };

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
