import type { Metadata } from 'next';
import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getDb } from '@/db/client';
import { requireUser } from '@/lib/auth/guards';
import { listarChecklist } from '@/lib/plataforma/checklists';
import { leerConfig } from '@/lib/plataforma/config-estudio';
import { esRolSuficiente } from '@/lib/plataforma/roles';
import { PLANTILLAS } from '@/lib/rubros/index';
import { RUBROS, type RubroId } from '@/types/domain';

import { FilaChecklist, FormulariosConfig, SinPermiso } from '../ui';

export const metadata: Metadata = { title: 'Configuración del estudio' };

/**
 * Configuración del estudio y checklists por rubro.
 *
 * Es de colaborador para arriba: la matriz le saca al colaborador cinco cosas y
 * configurar no es una de ellas (RF-1201). El de solo lectura no entra.
 */
export default async function ConfiguracionPage() {
  const { usuario, estudio } = await requireUser();
  if (!esRolSuficiente(usuario, 'colaborador')) {
    return <SinPermiso que="cambiar la configuración del estudio" minimo="colaborador" />;
  }

  const db = await getDb();
  const config = await leerConfig(db, estudio.id);
  const checklists = await Promise.all(
    RUBROS.map(async (rubro) => ({ rubro, items: await listarChecklist(db, estudio.id, rubro) })),
  );

  const desperdiciosDePlantilla = Object.fromEntries(
    RUBROS.map((rubro) => [rubro, PLANTILLAS[rubro].desperdicioDefaultPct]),
  ) as Record<RubroId, number>;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link href="/estudio" className="text-sm text-neutral-600 underline">
          ← Estudio
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          Configuración de {estudio.nombre}
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Cada bloque se guarda por su cuenta: lo que no tocás, no se toca.
        </p>
      </header>

      <FormulariosConfig config={config} desperdiciosDePlantilla={desperdiciosDePlantilla} />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
            Checklists por rubro
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            Qué se chequea antes de aprobar un rubro (RF-405). Un ítem que no se chequea, o que no
            frena, sigue apareciendo en la bandeja: lo que cambia es si traba la aprobación.{' '}
            <strong className="font-medium">
              El bloqueo por escala no está acá y no se puede desactivar
            </strong>{' '}
            — una lámina que no se pudo medir no se computó.
          </p>
        </div>

        {checklists.map(({ rubro, items }) => (
          <Card key={rubro}>
            <CardHeader>
              <CardTitle>{PLANTILLAS[rubro].nombre}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul>
                {items.map((item) => (
                  <FilaChecklist key={item.itemId} rubro={rubro} item={item} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
