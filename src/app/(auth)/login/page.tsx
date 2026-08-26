'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import { ingresarAction, type EstadoAuth } from '../actions';

const ESTADO_INICIAL: EstadoAuth = {};

export default function LoginPage() {
  const [estado, action, pendiente] = useActionState(ingresarAction, ESTADO_INICIAL);

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Entrá a Compulsa</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="flex flex-col gap-4">
            {estado.mensaje ? (
              <p
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                {estado.mensaje}
              </p>
            ) : null}

            <Input
              label="Mail"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={estado.valores?.email}
              error={estado.errores?.email}
            />
            <Input
              label="Contraseña"
              name="password"
              type="password"
              autoComplete="current-password"
              error={estado.errores?.password}
            />

            <Button type="submit" disabled={pendiente}>
              {pendiente ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>

          <p className="mt-4 text-sm text-neutral-600">
            ¿Todavía no tenés cuenta?{' '}
            <Link href="/register" className="font-medium text-neutral-900 underline">
              Registrá tu estudio
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
