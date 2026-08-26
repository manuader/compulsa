/**
 * La agenda de proveedores del estudio (RF-801).
 *
 * Server Component: lee la agenda con el estudio de la sesión y le pasa a la
 * tabla una vista **plana** (sin `Date` ni tipos de la base). Los filtros son un
 * `<form method="get">`: la URL es el estado, así un filtro se puede compartir
 * o marcar, y la pantalla no necesita JavaScript para filtrar.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { estilosBoton } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { getDb } from '@/db/client';
import type { Proveedor } from '@/db/schema';
import { requireUser } from '@/lib/auth/guards';
import { contactosDe, listarProveedores, zonasDe } from '@/lib/proveedores/gestion';
import { RUBROS, type RubroId } from '@/types/domain';

import { TablaProveedores, type ProveedorVista } from './ui';

export const metadata: Metadata = { title: 'Proveedores' };

/**
 * Local a propósito, igual que el `ETIQUETA_TIPO` de `/obras`: el gemelo de este
 * mapa vive en `ui.tsx`, que es un módulo `'use client'`. Todo lo que exporta un
 * módulo cliente llega al server como una **referencia**, no como el objeto: leer
 * `ETIQUETA_RUBRO[rubro]` acá reventaría en runtime. Cuatro líneas repetidas
 * valen más que un archivo nuevo compartido para esto.
 */
const ETIQUETA_RUBRO: Record<RubroId, string> = {
  aberturas: 'Aberturas',
  seco: 'Construcción en seco',
  pintura: 'Pintura',
  gruesa: 'Obra gruesa',
};

const FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function esRubro(valor: string | undefined): valor is RubroId {
  return valor !== undefined && (RUBROS as readonly string[]).includes(valor);
}

function aVista(proveedor: Proveedor): ProveedorVista {
  const contactos = contactosDe(proveedor);
  return {
    id: proveedor.id,
    nombre: proveedor.nombre,
    rubros: proveedor.rubros,
    zona: proveedor.zona,
    telefono: contactos.telefono ?? null,
    email: contactos.email ?? null,
    whatsapp: contactos.whatsapp ?? null,
    contacto: contactos.contacto ?? null,
    optInWa: proveedor.optInWa,
    optOut: proveedor.optOut,
    optInRegistradoEn: proveedor.optInRegistradoEn
      ? FECHA.format(proveedor.optInRegistradoEn)
      : null,
  };
}

/** "1 proveedor" y no "1 proveedores". */
function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

export default async function ProveedoresPage({
  searchParams,
}: {
  searchParams: Promise<{ rubro?: string; zona?: string }>;
}) {
  const { estudio } = await requireUser();
  const { rubro: rubroParam, zona: zonaParam } = await searchParams;

  const rubro = esRubro(rubroParam) ? rubroParam : undefined;
  const zona = zonaParam?.trim() ? zonaParam.trim() : undefined;

  const db = await getDb();
  // La agenda completa se lee igual: es la que puebla el desplegable de zonas,
  // que tiene que ofrecer todas y no solo las del filtro puesto.
  const agenda = await listarProveedores(db, estudio.id);
  const filtrados = await listarProveedores(db, estudio.id, { rubro, zona });

  const filtrando = rubro !== undefined || zona !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Proveedores</h1>
          <p className="text-sm text-neutral-600">{estudio.nombre}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/proveedores/importar" className={estilosBoton('secondary')}>
            Importar CSV
          </Link>
          <Link href="/proveedores/nuevo" className={estilosBoton()}>
            Agregar proveedor
          </Link>
        </div>
      </div>

      {agenda.length > 0 ? (
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="w-52">
            <Select label="Rubro" name="rubro" defaultValue={rubro ?? ''}>
              <option value="">Todos los rubros</option>
              {RUBROS.map((valor) => (
                <option key={valor} value={valor}>
                  {ETIQUETA_RUBRO[valor]}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-52">
            <Select label="Zona" name="zona" defaultValue={zona ?? ''}>
              <option value="">Todas las zonas</option>
              {zonasDe(agenda).map((valor) => (
                <option key={valor} value={valor}>
                  {valor}
                </option>
              ))}
            </Select>
          </div>
          <button type="submit" className={estilosBoton('secondary')}>
            Filtrar
          </button>
          {filtrando ? (
            <Link
              href="/proveedores"
              className="px-2 pb-2 text-sm text-neutral-600 hover:text-neutral-900"
            >
              Limpiar filtros
            </Link>
          ) : null}
        </form>
      ) : null}

      {agenda.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <p className="text-sm font-medium text-neutral-900">
              Todavía no tenés proveedores en la agenda.
            </p>
            <p className="text-sm text-neutral-600">
              Cargá el primero a mano o pegá el listado que ya tenés en un Excel: con la agenda
              armada, cada compulsa arranca con la shortlist hecha.
            </p>
            <div className="flex items-center gap-2">
              <Link href="/proveedores/nuevo" className={estilosBoton()}>
                Agregar el primero
              </Link>
              <Link href="/proveedores/importar" className={estilosBoton('secondary')}>
                Importar CSV
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : filtrados.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <p className="text-sm font-medium text-neutral-900">
              Ningún proveedor de la agenda cumple con ese filtro.
            </p>
            <Link href="/proveedores" className={estilosBoton('secondary')}>
              Ver los {agenda.length}
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-neutral-600">
            {filtrando
              ? `${plural(filtrados.length, 'proveedor', 'proveedores')} de ${agenda.length}.`
              : plural(agenda.length, 'proveedor en la agenda', 'proveedores en la agenda') + '.'}
          </p>
          <TablaProveedores proveedores={filtrados.map(aVista)} />
        </>
      )}
    </div>
  );
}
