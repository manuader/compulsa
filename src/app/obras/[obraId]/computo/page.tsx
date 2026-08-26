/**
 * Planilla de cómputo de la obra: una solapa por rubro, con su estado y su gate.
 *
 * La pantalla es un Server Component (`src/app/CLAUDE.md` §2): lee todo con
 * `getDb()`, filtra por rubro/origen/anulados desde la URL —así el estado de la
 * vista es compartible y no necesita JavaScript— y le pasa a la grilla solo
 * datos serializables. La interactividad (edición inline, alta, aprobación) vive
 * en `PlanillaRubro`, que llama a las server actions de `./actions`.
 */
import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PlanillaRubro } from '@/components/planilla/planilla-rubro';
import type { ItemPlanilla } from '@/components/planilla/planilla-rubro';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { getDb } from '@/db/client';
import { computoItems, computoRubros, hallazgos } from '@/db/schema';
import { requireObra } from '@/lib/auth/guards';
import { puedeAprobarRubro } from '@/lib/hallazgos/gate';
import { PLANTILLAS } from '@/lib/rubros/index';
import { ORIGENES, RUBROS, type EstadoRubro, type Origen, type RubroId } from '@/types/domain';

const ETIQUETA_ORIGEN: Record<Origen, string> = {
  explicito: 'Explícito',
  deducido: 'Deducido',
  supuesto: 'Supuesto',
};

const TONO_ESTADO_RUBRO: Record<EstadoRubro, BadgeTone> = {
  borrador: 'neutral',
  revision: 'info',
  aprobado: 'ok',
};

const ETIQUETA_ESTADO_RUBRO: Record<EstadoRubro, string> = {
  borrador: 'Borrador',
  revision: 'En revisión',
  aprobado: 'Aprobado',
};

interface Vista {
  rubro: RubroId;
  origen: Origen | null;
  verAnulados: boolean;
}

function enlace(obraId: string, vista: Vista): string {
  const query = new URLSearchParams({ rubro: vista.rubro });
  if (vista.origen) query.set('origen', vista.origen);
  if (vista.verAnulados) query.set('anulados', '1');
  return `/obras/${obraId}/computo?${query.toString()}`;
}

function primerParametro(valor: string | string[] | undefined): string | null {
  if (Array.isArray(valor)) return valor[0] ?? null;
  return valor ?? null;
}

function esRubro(valor: string | null): valor is RubroId {
  return valor !== null && (RUBROS as readonly string[]).includes(valor);
}

function esOrigen(valor: string | null): valor is Origen {
  return valor !== null && (ORIGENES as readonly string[]).includes(valor);
}

/** Chip de filtro: el estado de la vista viaja en la URL, no en el cliente. */
function Chip({ href, activo, children }: { href: string; activo: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={activo ? 'true' : undefined}
      className={[
        'inline-flex items-center rounded-full border px-3 py-1 text-sm transition-colors',
        activo
          ? 'border-neutral-900 bg-neutral-900 text-white'
          : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100',
      ].join(' ')}
    >
      {children}
    </Link>
  );
}

export const metadata: Metadata = { title: 'Cómputo' };

export default async function ComputoPage({
  params,
  searchParams,
}: {
  params: Promise<{ obraId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ obraId }, query] = await Promise.all([params, searchParams]);
  const obra = await requireObra(obraId);
  const db = await getDb();

  const [filas, estados, consultas] = await Promise.all([
    db
      .select()
      .from(computoItems)
      .where(eq(computoItems.obraId, obra.id))
      .orderBy(computoItems.rubro, computoItems.claveItem),
    db
      .select({ rubro: computoRubros.rubro, estado: computoRubros.estado })
      .from(computoRubros)
      .where(eq(computoRubros.obraId, obra.id)),
    db
      .select({ rubro: hallazgos.rubro, bloqueante: hallazgos.bloqueante, estado: hallazgos.estado })
      .from(hallazgos)
      .where(eq(hallazgos.obraId, obra.id)),
  ]);

  const estadoPorRubro = new Map<RubroId, EstadoRubro>(
    estados.map((fila) => [fila.rubro, fila.estado]),
  );
  const activosPorRubro = new Map<RubroId, number>(
    RUBROS.map((rubro) => [
      rubro,
      filas.filter((fila) => fila.rubro === rubro && fila.estado === 'activo').length,
    ]),
  );

  const pedido = primerParametro(query.rubro);
  // Sin rubro en la URL, arranca en el primero que tenga cómputo: nadie quiere
  // caer en una solapa vacía cuando hay ítems al lado.
  const rubro: RubroId = esRubro(pedido)
    ? pedido
    : (RUBROS.find((r) => (activosPorRubro.get(r) ?? 0) > 0) ?? RUBROS[0]);

  const origenPedido = primerParametro(query.origen);
  const origen: Origen | null = esOrigen(origenPedido) ? origenPedido : null;
  const verAnulados = primerParametro(query.anulados) === '1';

  const delRubro = filas.filter((fila) => fila.rubro === rubro);
  const anuladosDelRubro = delRubro.filter((fila) => fila.estado === 'anulado').length;

  const items: ItemPlanilla[] = delRubro
    .filter((fila) => (verAnulados ? true : fila.estado === 'activo'))
    .filter((fila) => (origen === null ? true : fila.origen === origen))
    .map((fila) => ({
      id: fila.id,
      claveItem: fila.claveItem,
      descripcion: fila.descripcion,
      unidad: fila.unidad,
      cantNeta: fila.cantNeta,
      desperdicioPct: fila.desperdicioPct,
      cantCompra: fila.cantCompra,
      presentacion: fila.presentacion,
      origen: fila.origen,
      confianza: fila.confianza,
      anulado: fila.estado === 'anulado',
      editado: fila.editadoPor !== null,
      laminaId: fila.fuentesJson[0]?.laminaId ?? null,
    }));

  const gate = puedeAprobarRubro(rubro, consultas);
  const vistaActual: Vista = { rubro, origen, verAnulados };

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Rubros" className="flex flex-wrap gap-2">
        {RUBROS.map((candidato) => {
          const estado = estadoPorRubro.get(candidato) ?? 'borrador';
          const activo = candidato === rubro;
          return (
            <Link
              key={candidato}
              href={enlace(obra.id, { rubro: candidato, origen, verAnulados })}
              aria-current={activo ? 'page' : undefined}
              className={[
                'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                activo
                  ? 'border-neutral-900 bg-white text-neutral-900 shadow-sm'
                  : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:text-neutral-900',
              ].join(' ')}
            >
              {PLANTILLAS[candidato].nombre}
              <span className="text-xs text-neutral-500 tabular-nums">
                {activosPorRubro.get(candidato) ?? 0}
              </span>
              <Badge tone={TONO_ESTADO_RUBRO[estado]}>{ETIQUETA_ESTADO_RUBRO[estado]}</Badge>
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Origen</span>
        <Chip href={enlace(obra.id, { ...vistaActual, origen: null })} activo={origen === null}>
          Todos
        </Chip>
        {ORIGENES.map((candidato) => (
          <Chip
            key={candidato}
            href={enlace(obra.id, { ...vistaActual, origen: candidato })}
            activo={origen === candidato}
          >
            {ETIQUETA_ORIGEN[candidato]}
          </Chip>
        ))}

        <span className="ml-2">
          <Chip
            href={enlace(obra.id, { ...vistaActual, verAnulados: !verAnulados })}
            activo={verAnulados}
          >
            {verAnulados ? 'Ocultar anulados' : `Ver anulados (${anuladosDelRubro})`}
          </Chip>
        </span>
      </div>

      <PlanillaRubro
        obraId={obra.id}
        rubro={rubro}
        nombreRubro={PLANTILLAS[rubro].nombre}
        estadoRubro={estadoPorRubro.get(rubro) ?? 'borrador'}
        desperdicioDefaultPct={PLANTILLAS[rubro].desperdicioDefaultPct}
        items={items}
        bloqueantes={gate.bloqueantes}
      />
    </div>
  );
}
