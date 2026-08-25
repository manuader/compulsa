'use client';

/**
 * Planilla de un rubro: la grilla editable, los totales por unidad, el alta de
 * ítems a mano y la aprobación del rubro.
 *
 * El botón de aprobar se deshabilita cuando el gate de consultas bloqueantes
 * (RF-404) no da, pero eso es **cortesía de la pantalla**: la verificación real
 * la hace `aprobarRubroAction` en el server. Si el gate cambia entre que se
 * pintó la pantalla y el click, gana el server y el mensaje aparece acá.
 */
import { useState, useTransition } from 'react';

import { aprobarRubroAction, crearItemManualAction } from '@/app/obras/[obraId]/computo/actions';
import { FilaItem, type ItemPlanilla } from '@/components/planilla/fila-item';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { ETIQUETA_UNIDAD, formatearNumero, redondear2 } from '@/lib/computo/unidades';
import { UNIDADES, type EstadoRubro, type RubroId, type Unidad } from '@/types/domain';

export type { ItemPlanilla };

const ETIQUETA_ESTADO_RUBRO: Record<EstadoRubro, string> = {
  borrador: 'Borrador',
  revision: 'En revisión',
  aprobado: 'Aprobado',
};

const TONO_ESTADO_RUBRO: Record<EstadoRubro, BadgeTone> = {
  borrador: 'neutral',
  revision: 'info',
  aprobado: 'ok',
};

const NOMBRE_UNIDAD: Record<Unidad, string> = {
  u: 'unidad',
  m: 'metro',
  ml: 'metro lineal',
  m2: 'metro cuadrado',
  m3: 'metro cúbico',
  l: 'litro',
  kg: 'kilo',
};

/** Total de netas y de compra por unidad: sumar peras con manzanas no sirve. */
export function totalesPorUnidad(
  items: readonly ItemPlanilla[],
): { unidad: Unidad; cantNeta: number; cantCompra: number }[] {
  const totales = new Map<Unidad, { cantNeta: number; cantCompra: number }>();
  for (const item of items) {
    if (item.anulado) continue; // lo anulado no suma
    const actual = totales.get(item.unidad) ?? { cantNeta: 0, cantCompra: 0 };
    totales.set(item.unidad, {
      cantNeta: redondear2(actual.cantNeta + item.cantNeta),
      cantCompra: redondear2(actual.cantCompra + item.cantCompra),
    });
  }
  return UNIDADES.filter((unidad) => totales.has(unidad)).map((unidad) => ({
    unidad,
    ...totales.get(unidad)!,
  }));
}

export interface PlanillaRubroProps {
  obraId: string;
  rubro: RubroId;
  nombreRubro: string;
  estadoRubro: EstadoRubro;
  /** Desperdicio de referencia del rubro: prellena el alta manual. */
  desperdicioDefaultPct: number;
  items: readonly ItemPlanilla[];
  /** Consultas bloqueantes abiertas del rubro (0 ⇒ el gate da). */
  bloqueantes: number;
}

export function PlanillaRubro({
  obraId,
  rubro,
  nombreRubro,
  estadoRubro,
  desperdicioDefaultPct,
  items,
  bloqueantes,
}: PlanillaRubroProps) {
  const [dialogoAlta, setDialogoAlta] = useState(false);
  const [dialogoAprobacion, setDialogoAprobacion] = useState(false);
  const [errorAlta, setErrorAlta] = useState<string | null>(null);
  const [errorAprobacion, setErrorAprobacion] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  const [descripcion, setDescripcion] = useState('');
  const [unidad, setUnidad] = useState<Unidad>('u');
  const [cantNeta, setCantNeta] = useState('');
  const [desperdicioPct, setDesperdicioPct] = useState(formatearNumero(desperdicioDefaultPct));

  const totales = totalesPorUnidad(items);
  const gateOk = bloqueantes === 0;
  const yaAprobado = estadoRubro === 'aprobado';
  const motivoGate = gateOk
    ? undefined
    : bloqueantes === 1
      ? 'Queda 1 consulta bloqueante abierta en la bandeja.'
      : `Quedan ${bloqueantes} consultas bloqueantes abiertas en la bandeja.`;

  function crearItem(): void {
    setErrorAlta(null);
    iniciar(async () => {
      const resultado = await crearItemManualAction({
        obraId,
        rubro,
        descripcion,
        unidad,
        cantNeta,
        desperdicioPct,
      });
      if (!resultado.ok) {
        setErrorAlta(resultado.error);
        return;
      }
      setDescripcion('');
      setCantNeta('');
      setDesperdicioPct(formatearNumero(desperdicioDefaultPct));
      setDialogoAlta(false);
    });
  }

  function aprobar(): void {
    setErrorAprobacion(null);
    iniciar(async () => {
      const resultado = await aprobarRubroAction({ obraId, rubro });
      if (resultado.ok) setDialogoAprobacion(false);
      else setErrorAprobacion(resultado.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-neutral-900">{nombreRubro}</h2>
          <Badge tone={TONO_ESTADO_RUBRO[estadoRubro]}>{ETIQUETA_ESTADO_RUBRO[estadoRubro]}</Badge>
          {motivoGate ? <Badge tone="warn">{motivoGate}</Badge> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setDialogoAlta(true)}>
            Agregar ítem
          </Button>
          <span title={yaAprobado ? 'El rubro ya está aprobado.' : motivoGate}>
            <Button
              size="sm"
              disabled={!gateOk || yaAprobado || pendiente}
              onClick={() => setDialogoAprobacion(true)}
            >
              {yaAprobado ? 'Rubro aprobado' : 'Aprobar rubro'}
            </Button>
          </span>
          <a
            href={`/api/obras/${obraId}/export?rubro=${rubro}`}
            className="inline-flex h-8 items-center justify-center rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
          >
            Exportar XLSX
          </a>
        </div>
      </div>

      {errorAprobacion ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorAprobacion}
        </p>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white px-4 py-10 text-center">
          <p className="text-sm font-medium text-neutral-900">
            Todavía no hay ítems computados en {nombreRubro.toLowerCase()}.
          </p>
          <p className="mt-1 text-sm text-neutral-600">
            Aparecen solos cuando el análisis detecta las entidades del rubro. Si ya sabés lo que
            falta, agregalo a mano.
          </p>
        </div>
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Descripción</TableHeaderCell>
              <TableHeaderCell>Unidad</TableHeaderCell>
              <TableHeaderCell numeric>Cant. neta</TableHeaderCell>
              <TableHeaderCell numeric>Desp. %</TableHeaderCell>
              <TableHeaderCell numeric>Cant. compra</TableHeaderCell>
              <TableHeaderCell>Presentación</TableHeaderCell>
              <TableHeaderCell>Origen</TableHeaderCell>
              <TableHeaderCell numeric>Confianza</TableHeaderCell>
              <TableHeaderCell>Fuente</TableHeaderCell>
              <TableHeaderCell>Acciones</TableHeaderCell>
            </TableRow>
          </TableHead>

          <TableBody>
            {items.map((item) => (
              <FilaItem key={item.id} obraId={obraId} item={item} />
            ))}

            {totales.map((total) => (
              <TableRow key={`total-${total.unidad}`} className="bg-neutral-50 font-medium">
                <TableCell colSpan={2}>Total en {ETIQUETA_UNIDAD[total.unidad]}</TableCell>
                <TableCell numeric>{formatearNumero(total.cantNeta)}</TableCell>
                <TableCell />
                <TableCell numeric>{formatearNumero(total.cantCompra)}</TableCell>
                <TableCell colSpan={5} className="text-xs font-normal text-neutral-500">
                  Suma de los ítems activos que se ven en la tabla.
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={dialogoAlta}
        onClose={() => setDialogoAlta(false)}
        title={`Agregar ítem a ${nombreRubro.toLowerCase()}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogoAlta(false)} disabled={pendiente}>
              Cancelar
            </Button>
            <Button onClick={crearItem} disabled={pendiente}>
              {pendiente ? 'Agregando…' : 'Agregar'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-600">
            Un ítem cargado a mano no tiene fuente en los planos: queda marcado como tuyo y el
            recómputo no lo pisa.
          </p>
          <Input
            label="Descripción"
            placeholder="Zócalo de madera 7 cm"
            value={descripcion}
            onChange={(evento) => setDescripcion(evento.target.value)}
            disabled={pendiente}
          />
          <Select
            label="Unidad"
            value={unidad}
            onChange={(evento) => setUnidad(evento.target.value as Unidad)}
            disabled={pendiente}
          >
            {UNIDADES.map((valor) => (
              <option key={valor} value={valor}>
                {ETIQUETA_UNIDAD[valor]} — {NOMBRE_UNIDAD[valor]}
              </option>
            ))}
          </Select>
          <Input
            label="Cantidad neta"
            inputMode="decimal"
            placeholder="30,5"
            value={cantNeta}
            onChange={(evento) => setCantNeta(evento.target.value)}
            disabled={pendiente}
          />
          <Input
            label="Desperdicio (%)"
            inputMode="decimal"
            value={desperdicioPct}
            onChange={(evento) => setDesperdicioPct(evento.target.value)}
            disabled={pendiente}
          />
          {errorAlta ? <p className="text-sm text-red-700">{errorAlta}</p> : null}
        </div>
      </Dialog>

      <Dialog
        open={dialogoAprobacion}
        onClose={() => setDialogoAprobacion(false)}
        title={`Aprobar ${nombreRubro.toLowerCase()}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogoAprobacion(false)} disabled={pendiente}>
              Cancelar
            </Button>
            <Button onClick={aprobar} disabled={pendiente}>
              {pendiente ? 'Aprobando…' : 'Aprobar rubro'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-neutral-700">
          Vas a dar por bueno el cómputo de {nombreRubro.toLowerCase()}: queda registrado con tu
          usuario y la fecha. Podés seguir editando ítems después, pero la aprobación es lo que
          habilita pedir cotizaciones.
        </p>
      </Dialog>
    </div>
  );
}
