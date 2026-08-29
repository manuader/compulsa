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

import { VerificacionComputo } from '@/app/obras/[obraId]/computo/verificacion-ui';
import { escalaAsumidaDelItem, type LaminaDeFuente } from '@/components/planilla/escala-asumida';
import { PlanillaRubro } from '@/components/planilla/planilla-rubro';
import type { ItemPlanilla, SubtotalRubro } from '@/components/planilla/planilla-rubro';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { getDb } from '@/db/client';
import { computoItems, computoRubros, hallazgos, laminas, type ComputoItem } from '@/db/schema';
import { requireObra, requireUser } from '@/lib/auth/guards';
import { formatearMonto } from '@/lib/compulsa/comparativa';
import { redondear2 } from '@/lib/computo/unidades';
import { puedeAprobarRubro } from '@/lib/hallazgos/gate';
import { esClaveDeVerificacion } from '@/lib/pipeline/claves';
import { ajustarHallazgosAlChecklist, checklistEfectivo } from '@/lib/plataforma/checklists';
import { esRolSuficiente } from '@/lib/plataforma/roles';
import { PLANTILLAS } from '@/lib/rubros/index';
import {
  ORIGENES,
  RUBROS,
  type EstadoRubro,
  type Fuente,
  type Origen,
  type PrecioEstimado,
  type RubroId,
} from '@/types/domain';

const ETIQUETA_ORIGEN: Record<Origen, string> = {
  explicito: 'Explícito',
  deducido: 'Deducido',
  supuesto: 'Supuesto',
  inferido: 'Inferido',
};

/** De dónde salió el precio, para el tooltip de la fila (§5.6). */
const ETIQUETA_FUENTE_PRECIO: Record<PrecioEstimado['fuente'], string> = {
  manual: 'Precio cargado a mano',
  lista: 'Lista de precios del estudio',
  indice: 'Índice de precios del estudio',
};

/**
 * La fecha del precio, como se escribe en es-AR.
 *
 * Vienen de dos formas y las dos son ciertas: la lista y el precio manual traen
 * el día (`2026-08-20`), y el índice es mensual (`2026-08`) — completarle un
 * `-01` sería declarar una precisión que la fila no tiene (§5.6, decisión de
 * `resolverPrecio`). Se muestran distinto porque **son** distintas.
 */
function fechaDePrecio(iso: string): string {
  const partes = iso.split('-');
  if (partes.length === 3) return `${partes[2]}/${partes[1]}/${partes[0]}`;
  if (partes.length === 2) return `${partes[1]}/${partes[0]}`;
  return iso;
}

/**
 * El precio como hay que meterlo en el input: coma decimal y **sin separador de
 * miles**. Mismo criterio (y misma razón) que `/estudio/precios`: `parsearPrecio`
 * lee un separador solo, una vez, como decimal, así que abrir la fila de un
 * precio de 145.000 y guardarla sin tocarla lo dejaría en 145.
 */
function precioEditable(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

/** El subtotal del ítem: lo que se paga por comprar la cantidad de compra. */
function subtotalDeItem(fila: ComputoItem): number | null {
  if (fila.precioJson === null) return null;
  return redondear2(fila.precioJson.unitario * fila.cantCompra);
}

/**
 * Por qué un ítem no es explícito, con lo que lo respalda.
 *
 * Es el tooltip del badge: un `deducido` sin decir de dónde salió obliga a
 * abrir la bandeja para entenderlo, y un `inferido` sin decir que se midió
 * sobre el dibujo parece un dato leído.
 *
 * El método de una medición gráfica todavía no se persiste por ítem (el dato
 * vive en la deducción que la produjo, y esa la escribe el pipeline de T9), así
 * que el texto es el fijo del §5.5. Cuando haya método guardado, se lee de ahí.
 */
function detalleDeOrigen(origen: Origen, laminas: readonly string[]): string | null {
  if (origen === 'explicito') return null;
  const citadas = laminas.length === 0 ? '' : ` Láminas: ${laminas.join(', ')}.`;
  if (origen === 'deducido') {
    return `Se dedujo cruzando la documentación; el dato no está escrito en una sola lámina.${citadas}`;
  }
  if (origen === 'inferido') {
    return `Se midió sobre el dibujo a escala (medición gráfica): es la más débil de las evidencias.${citadas}`;
  }
  return `Se computó sobre un supuesto declarado de la plantilla del rubro.${citadas}`;
}

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

/**
 * Lo que suman los ítems **con precio** de un conjunto, y cuántos quedaron sin.
 *
 * Los dos números van juntos siempre: un total que calla que veinte ítems no
 * tienen precio es peor que no mostrar nada. `null` ⇒ ninguno tiene precio, y
 * entonces no hay total que mostrar (el cero sería una afirmación falsa).
 */
function totalizar(filas: readonly ComputoItem[], moneda: string): SubtotalRubro | null {
  let suma = 0;
  let conPrecio = 0;
  let sinPrecio = 0;
  for (const fila of filas) {
    const subtotal = subtotalDeItem(fila);
    if (subtotal === null) {
      sinPrecio += 1;
      continue;
    }
    suma = redondear2(suma + subtotal);
    conPrecio += 1;
  }
  if (conPrecio === 0) return null;
  return { monto: formatearMonto(moneda, suma), sinPrecio };
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
  const { estudio, usuario } = await requireUser();
  const obra = await requireObra(obraId);
  const db = await getDb();

  const [filas, estados, consultas, planos] = await Promise.all([
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
      .select({
        rubro: hallazgos.rubro,
        bloqueante: hallazgos.bloqueante,
        estado: hallazgos.estado,
        checklistItem: hallazgos.checklistItem,
        // RF-306: las consultas que dejó la última doble pasada se muestran
        // arriba de la planilla, junto al botón que las genera.
        clave: hallazgos.clave,
        descripcion: hallazgos.descripcion,
      })
      .from(hallazgos)
      .where(eq(hallazgos.obraId, obra.id)),
    // Las láminas con su escala: cruzadas con las `fuentes_json` del ítem son
    // las que dicen si el número salió de una escala verificada contra cotas o
    // de una asumida (decisión 1). No hace falta ninguna columna nueva.
    db
      .select({
        id: laminas.id,
        codigo: laminas.codigo,
        numeroPagina: laminas.numeroPagina,
        escala: laminas.escala,
        escalaConfiable: laminas.escalaConfiable,
        tipo: laminas.tipo,
      })
      .from(laminas)
      .where(eq(laminas.obraId, obra.id)),
  ]);

  // Para el aviso alcanza con el código de la lámina ("A-04"): el tooltip tiene
  // que entrar en una fila de la planilla, no repetir el rótulo entero.
  const escalaPorLamina = new Map<string, LaminaDeFuente>(
    planos.map((fila) => [
      fila.id,
      {
        laminaId: fila.id,
        etiqueta: fila.codigo ?? `Página ${fila.numeroPagina}`,
        escala: fila.escala,
        escalaConfiable: fila.escalaConfiable,
        tipo: fila.tipo,
      },
    ]),
  );

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

  /** Los códigos de las láminas que cita un ítem, sin repetir: van en el tooltip. */
  const nombrarLaminas = (fuentes: readonly Fuente[]): string[] => [
    ...new Set(fuentes.map((fuente) => escalaPorLamina.get(fuente.laminaId)?.etiqueta ?? '')),
  ].filter((etiqueta) => etiqueta !== '');

  const items: ItemPlanilla[] = delRubro
    .filter((fila) => (verAnulados ? true : fila.estado === 'activo'))
    .filter((fila) => (origen === null ? true : fila.origen === origen))
    .map((fila) => {
      const subtotal = subtotalDeItem(fila);
      const precio = fila.precioJson;
      return {
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
        escalaAsumida: escalaAsumidaDelItem(fila.fuentesJson, escalaPorLamina),
        precio:
          precio === null || subtotal === null
            ? null
            : {
                unitario: formatearMonto(precio.moneda, precio.unitario),
                subtotal: formatearMonto(precio.moneda, subtotal),
                detalle: `${ETIQUETA_FUENTE_PRECIO[precio.fuente]} · ${fechaDePrecio(precio.fechaPrecio)}`,
              },
        precioEditable: precio === null ? '' : precioEditable(precio.unitario),
        origenDetalle: detalleDeOrigen(fila.origen, nombrarLaminas(fila.fuentesJson)),
      };
    });

  // Los totales van sobre los ítems ACTIVOS, filtre lo que filtre la vista: el
  // filtro de origen cambia qué se mira, no lo que sale la obra.
  const activos = filas.filter((fila) => fila.estado === 'activo');
  const activosDelRubro = activos.filter((fila) => fila.rubro === rubro);
  const subtotalRubro = totalizar(activosDelRubro, obra.moneda);
  const totalObra = totalizar(activos, obra.moneda);

  // El mismo gate que aplica `aprobarRubroAction`, checklist del estudio
  // incluido: si la pantalla dijera otra cosa que el server, el botón mentiría.
  const gate = puedeAprobarRubro(
    rubro,
    ajustarHallazgosAlChecklist(consultas, await checklistEfectivo(db, estudio.id, rubro)),
  );
  const vistaActual: Vista = { rubro, origen, verAnulados };

  const consultasDeVerificacion = consultas
    .filter((fila) => fila.estado === 'abierto' && esClaveDeVerificacion(fila.clave))
    .map((fila) => ({ clave: fila.clave, descripcion: fila.descripcion }));

  return (
    <div className="flex flex-col gap-4">
      <VerificacionComputo
        obraId={obra.id}
        puedeVerificar={esRolSuficiente(usuario, 'colaborador')}
        consultasAbiertas={consultasDeVerificacion}
      />

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
        subtotal={subtotalRubro}
        bloqueantes={gate.bloqueantes}
        puedeEditar={esRolSuficiente(usuario, 'colaborador')}
        puedeAprobar={esRolSuficiente(usuario, 'titular')}
      />

      {/* El total de la obra es de la obra entera, no de la solapa: va abajo de
          todo y dice con cuántos ítems no pudo contar. Un total estimado que no
          declara sus huecos es un presupuesto, y esto no lo es. */}
      <section className="rounded-lg border border-neutral-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-neutral-600">Total estimado de la obra</h2>
          <p className="text-lg font-semibold text-neutral-900 tabular-nums">
            {totalObra ? totalObra.monto : 'Sin precios todavía'}
          </p>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {totalObra === null
            ? 'Ningún ítem tiene precio: cargá la lista del estudio en Precios, o registrá cotizaciones para que el índice tenga muestras.'
            : totalObra.sinPrecio === 0
              ? 'Suma todos los ítems activos del cómputo, con el precio de la lista del estudio o del índice.'
              : `Suma solo los ítems con precio: ${totalObra.sinPrecio === 1 ? 'queda 1 ítem sin precio' : `quedan ${totalObra.sinPrecio} ítems sin precio`} y no está contado acá.`}
        </p>
      </section>
    </div>
  );
}
