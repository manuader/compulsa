'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

import { crearObraAction, type EstadoNuevaObra } from '../actions';

const ESTADO_INICIAL: EstadoNuevaObra = {};

export default function NuevaObraPage() {
  const [estado, action, pendiente] = useActionState(crearObraAction, ESTADO_INICIAL);

  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>Crear obra</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-neutral-600">
            Con esto queda armado el expediente. Después subí planos y pliegos para que arranque el
            análisis.
          </p>

          <form action={action} className="flex flex-col gap-4">
            <Input
              label="Nombre de la obra"
              name="nombre"
              placeholder="Casa Belgrano"
              defaultValue={estado.valores?.nombre}
              error={estado.errores?.nombre}
            />
            <Input
              label="Zona"
              name="zona"
              placeholder="CABA — Belgrano R"
              defaultValue={estado.valores?.zona}
              error={estado.errores?.zona}
            />
            <Select
              label="Tipo de obra"
              name="tipo"
              defaultValue={estado.valores?.tipo ?? 'nueva'}
              error={estado.errores?.tipo}
            >
              <option value="nueva">Obra nueva</option>
              <option value="reforma">Reforma</option>
              <option value="ampliacion">Ampliación</option>
            </Select>
            <Select
              label="Moneda"
              name="moneda"
              defaultValue={estado.valores?.moneda ?? 'ARS'}
              error={estado.errores?.moneda}
            >
              <option value="ARS">Pesos (ARS)</option>
              <option value="USD">Dólares (USD)</option>
            </Select>

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={pendiente}>
                {pendiente ? 'Creando…' : 'Crear obra'}
              </Button>
              <Link href="/obras" className="px-3 text-sm text-neutral-600 hover:text-neutral-900">
                Cancelar
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
