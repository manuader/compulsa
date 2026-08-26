'use client';

/**
 * Las dos piezas interactivas de la comparativa. Todo lo demás —el cuadro, el
 * ranking, las leyendas— es server component: son datos, no interacción.
 *
 * **Adjudicar pide confirmación con el resumen adentro** (`src/app/CLAUDE.md`
 * §6). No es un "¿estás seguro?": el diálogo repite a quién se le adjudica, por
 * cuánto, cuántos ítems entran y cuántos quedan sin comparar, y qué pasa con
 * los otros proveedores. Es la última pantalla antes de un documento comercial,
 * así que tiene que decir exactamente qué se va a firmar.
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

export interface ResumenAdjudicacion {
  proveedorNombre: string;
  /** Total ya formateado con su símbolo ("$ 1.875.400,50"). */
  total: string | null;
  moneda: string;
  itemsComparables: number;
  itemsExcluidos: number;
  totalComparable: string;
  difiereDelDeclarado: boolean;
  puntaje: number | null;
  posicion: number | null;
  validez: string;
  /** Cuántos proveedores más quedan en juego y se van a cerrar. */
  otrosContactos: number;
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

          {resumen.difiereDelDeclarado ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
              El total declarado no coincide con la suma del cuadro. La orden de compra sale por el
              total declarado y lo aclara.
            </p>
          ) : null}

          {requiereTotal ? (
            <Input
              label="Total de la cotización"
              inputMode="decimal"
              placeholder="1.234.500"
              value={total}
              onChange={(event) => setTotal(event.target.value)}
              // Se persiste en la cotización: es el número por el que se compró
              // y contra el que se va a medir el ahorro.
              error={undefined}
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

/**
 * Copiar la orden de compra al portapapeles. El texto viaja desde el server ya
 * armado: el botón no lo genera ni lo reformatea, solo lo copia — el que se
 * manda tiene que ser byte por byte el que quedó guardado en `adjudicaciones`.
 */
export function BotonCopiar({ texto, etiqueta = 'Copiar' }: { texto: string; etiqueta?: string }) {
  const [copiado, setCopiado] = useState(false);

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(texto);
        setCopiado(true);
        setTimeout(() => setCopiado(false), 2000);
      }}
    >
      {copiado ? '¡Copiado!' : etiqueta}
    </Button>
  );
}
