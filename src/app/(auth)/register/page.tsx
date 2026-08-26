'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import { registrarAction, type EstadoAuth } from '../actions';

const ESTADO_INICIAL: EstadoAuth = {};

export default function RegisterPage() {
  const [estado, action, pendiente] = useActionState(registrarAction, ESTADO_INICIAL);

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Registrá tu estudio</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-neutral-600">
            Creás el estudio y quedás como titular. Después sumás a tu equipo y cargás la primera
            obra.
          </p>

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
              label="Nombre del estudio"
              name="nombreEstudio"
              autoComplete="organization"
              placeholder="Estudio Norte"
              defaultValue={estado.valores?.nombreEstudio}
              error={estado.errores?.nombreEstudio}
            />
            <Input
              label="Tu nombre"
              name="nombre"
              autoComplete="name"
              defaultValue={estado.valores?.nombre}
              error={estado.errores?.nombre}
            />
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
              autoComplete="new-password"
              error={estado.errores?.password}
            />

            <Button type="submit" disabled={pendiente}>
              {pendiente ? 'Creando…' : 'Crear cuenta'}
            </Button>
          </form>

          <p className="mt-4 text-sm text-neutral-600">
            ¿Ya tenés cuenta?{' '}
            <Link href="/login" className="font-medium text-neutral-900 underline">
              Entrá
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
