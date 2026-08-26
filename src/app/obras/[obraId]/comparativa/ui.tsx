'use client';

/**
 * La pieza interactiva de la comparativa: el botón de adjudicar con su
 * confirmación. Todo lo demás —el cuadro, el ranking, las leyendas— es server
 * component: son datos, no interacción. (El de copiar la orden de compra es la
 * primitiva compartida `@/components/ui/boton-copiar`.)
 *
 * **Adjudicar pide confirmación con el resumen adentro** (`src/app/CLAUDE.md`
 * §6). No es un "¿estás seguro?": el diálogo repite a quién se le adjudica, por
 * cuánto, cuántos ítems entran y cuántos quedan sin comparar, y qué pasa con
 * los otros proveedores. Es la última pantalla antes de un documento comercial,
 * así que tiene que decir exactamente qué se va a firmar — y si el proveedor
 * cambió una especificación, lo dice **en rojo y con la lista** (PRD §12): eso
 * no es un detalle del cuadro, es comprar otra cosa.
 *
 * El botón que se ve o no se ve **no es la autorización**: el rol lo exige el
 * núcleo (`adjudicarCompulsa` → `requireAccion`). Esconderlo es cortesía con el
 * colaborador, no seguridad.
 */
import { useState, useTransition } from 'react';

import { adjudicarAction } from '@/app/obras/[obraId]/comparativa/actions';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/** Un ítem que este proveedor cotizó cambiando una especificación (PRD §12). */
export interface SustitucionResumen {
  claveItem: string;
  descripcion: string;
  detalle: string;
}

export interface ResumenAdjudicacion {
  proveedorNombre: string;
  /** Total ya formateado con su símbolo ("$ 1.875.400,50"). */
  total: string | null;
  itemsComparables: number;
  itemsExcluidos: number;
  totalComparable: string;
  difiereDelDeclarado: boolean;
  /** Puntaje del ranking ya formateado en es-AR ("0,6179"). */
  puntaje: string | null;
  posicion: number | null;
  validez: string;
  /** Cuántos proveedores más quedan en juego y se van a cerrar. */
  otrosContactos: number;
  /**
   * Las especificaciones que este proveedor cambió. Vacío en el caso normal;
   * con una sola, el diálogo se pone en rojo y las lista (PRD §12).
   */
  sustituciones: SustitucionResumen[];
}

export interface BotonAdjudicarProps {
  obraId: string;
  cotizacionId: string;
  resumen: ResumenAdjudicacion;
  /** La cotización no tiene total declarado: hay que cargarlo para adjudicar. */
  requiereTotal: boolean;
}

export function BotonAdjudicar({
  obraId,
  cotizacionId,
  resumen,
  requiereTotal,
}: BotonAdjudicarProps) {
  const [abierto, setAbierto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState('');
  const [pendiente, iniciar] = useTransition();

  function confirmar(): void {
    setError(null);
    const cargado = total.trim().replace(/\./g, '').replace(',', '.');
    const numero = cargado === '' ? null : Number(cargado);

    if (requiereTotal && (numero === null || !Number.isFinite(numero) || numero <= 0)) {
      setError('Cargá el total de la cotización para poder adjudicarla.');
      return;
    }

    iniciar(async () => {
      const resultado = await adjudicarAction({ obraId, cotizacionId, total: numero });
      if (resultado.ok) {
        setAbierto(false);
        return;
      }
      setError(resultado.error);
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => setAbierto(true)} disabled={pendiente}>
        {pendiente ? 'Adjudicando…' : 'Adjudicar'}
      </Button>

      <Dialog
        open={abierto}
        onClose={() => setAbierto(false)}
        title={`Adjudicar a ${resumen.proveedorNombre}`}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setAbierto(false)}>
              Cancelar
            </Button>
            <Button size="sm" onClick={confirmar} disabled={pendiente}>
              {pendiente ? 'Adjudicando…' : 'Sí, adjudicar'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-neutral-500">Total a adjudicar</dt>
            <dd className="font-medium text-neutral-900">
              {resumen.total ?? 'sin total declarado'}
            </dd>
            <dt className="text-neutral-500">Suma del cuadro</dt>
            <dd className="text-neutral-900">{resumen.totalComparable}</dd>
            <dt className="text-neutral-500">Ítems</dt>
            <dd className="text-neutral-900">
              {resumen.itemsComparables} comparables
              {resumen.itemsExcluidos > 0 ? `, ${resumen.itemsExcluidos} sin comparar` : ''}
            </dd>
            <dt className="text-neutral-500">Ranking</dt>
            <dd className="text-neutral-900">
              {resumen.posicion === null
                ? 'sin puntaje (falta el total)'
                : `${resumen.posicion}º con ${resumen.puntaje}`}
            </dd>
            <dt className="text-neutral-500">Validez</dt>
            <dd className="text-neutral-900">{resumen.validez}</dd>
          </dl>

          {/* PRD §12: una sustitución de especificación se ve EN ROJO y
              adjudicarla es una decisión explícita. Va antes que el aviso de
              total ≠ cuadro porque es la más cara de las dos: comprar otra cosa
              es peor que comprar por otro número. */}
          {resumen.sustituciones.length > 0 ? (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800">
              <p className="font-medium">
                Esta cotización sustituye{' '}
                {resumen.sustituciones.length === 1
                  ? '1 especificación'
                  : `${resumen.sustituciones.length} especificaciones`}{' '}
                — revisalas antes de adjudicar.
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {resumen.sustituciones.map((sustitucion) => (
                  <li key={sustitucion.claveItem}>
                    <strong className="font-medium">{sustitucion.descripcion}</strong> (
                    {sustitucion.claveItem}): {sustitucion.detalle}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {resumen.difiereDelDeclarado ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
              El total declarado no coincide con la suma del cuadro. La orden de compra sale por el
              total declarado y lo aclara.
            </p>
          ) : null}

          {/* El total se persiste en la cotización: es el número por el que se
              compró y contra el que se va a medir el ahorro. */}
          {requiereTotal ? (
            <Input
              label="Total de la cotización"
              inputMode="decimal"
              placeholder="1.234.500"
              value={total}
              onChange={(event) => setTotal(event.target.value)}
            />
          ) : null}

          <p className="text-neutral-600">
            Se genera la orden de compra, la compulsa queda adjudicada y
            {resumen.otrosContactos === 0
              ? ' se cierra el contacto con el proveedor.'
              : ` se cierran los otros ${resumen.otrosContactos} contactos de la compulsa.`}{' '}
            No se puede deshacer desde el producto.
          </p>

          {error ? <p className="text-red-700">{error}</p> : null}
        </div>
      </Dialog>
    </>
  );
}

