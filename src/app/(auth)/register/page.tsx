'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

import { registrarAction, type EstadoAuth } from '../actions';

const ESTADO_INICIAL: EstadoAuth = {};

/**
 * Alta de cuenta por los dos caminos: creando estudio (quedás titular) o con un
 * código de invitación (te sumás al estudio que te invitó, con el rol que la
 * invitación diga).
 *
 * El formulario es uno solo y el server decide el camino mirando si vino un
 * código: si el link llegó como `/register?codigo=ABCD2345`, el campo aparece
 * lleno y el modo arranca en "me invitaron".
 */
function FormularioRegistro() {
  const parametros = useSearchParams();
  const codigoDeLaUrl = parametros.get('codigo') ?? '';

  const [estado, action, pendiente] = useActionState(registrarAction, ESTADO_INICIAL);
  const [conCodigo, setConCodigo] = useState(
    codigoDeLaUrl !== '' || Boolean(estado.valores?.codigoInvitacion),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{conCodigo ? 'Sumate a tu estudio' : 'Registrá tu estudio'}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-neutral-600">
          {conCodigo
            ? 'Con el código que te pasó el titular entrás al estudio que ya existe, con el rol que él eligió.'
            : 'Creás el estudio y quedás como titular. Después sumás a tu equipo y cargás la primera obra.'}
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

          {conCodigo ? (
            <Input
              label="Código de invitación"
              name="codigoInvitacion"
              autoComplete="off"
              spellCheck={false}
              placeholder="ABCD2345"
              className="uppercase tracking-widest"
              defaultValue={estado.valores?.codigoInvitacion || codigoDeLaUrl}
              error={estado.errores?.codigoInvitacion}
            />
          ) : (
            <Input
              label="Nombre del estudio"
              name="nombreEstudio"
              autoComplete="organization"
              placeholder="Estudio Norte"
              defaultValue={estado.valores?.nombreEstudio}
              error={estado.errores?.nombreEstudio}
            />
          )}

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
            {pendiente ? 'Creando…' : conCodigo ? 'Sumarme al estudio' : 'Crear cuenta'}
          </Button>
        </form>

        <p className="mt-4 text-sm text-neutral-600">
          {conCodigo ? '¿Querés crear tu propio estudio? ' : '¿Te invitaron a un estudio? '}
          <button
            type="button"
            onClick={() => setConCodigo((valor) => !valor)}
            className="font-medium text-neutral-900 underline"
          >
            {conCodigo ? 'Registrá tu estudio' : 'Entrá con el código'}
          </button>
          .
        </p>

        <p className="mt-2 text-sm text-neutral-600">
          ¿Ya tenés cuenta?{' '}
          <Link href="/login" className="font-medium text-neutral-900 underline">
            Entrá
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

export default function RegisterPage() {
  return (
    <div className="mx-auto max-w-md">
      {/* `useSearchParams` obliga a un límite de Suspense en el App Router. */}
      <Suspense fallback={null}>
        <FormularioRegistro />
      </Suspense>
    </div>
  );
}
