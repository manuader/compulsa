'use client';

/**
 * Una fila de la planilla de cómputo, con edición inline.
 *
 * Lo que la fila manda al server es solo lo que escribió la persona
 * —descripción, cantidad neta, desperdicio—: la cantidad de compra y la
 * presentación las recalcula `editarItemAction` (P2: la compra no se edita a
 * mano, se deduce del bulto comercial). Por eso esos dos campos se muestran
 * siempre en modo lectura, incluso mientras se edita la fila.
 */
import Link from 'next/link';
import { useState, useTransition } from 'react';

import { anularItemAction, editarItemAction } from '@/app/obras/[obraId]/computo/actions';
import { textoEscalaAsumida, type EscalaAsumida } from '@/components/planilla/escala-asumida';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TableCell, TableRow } from '@/components/ui/table';
import { ETIQUETA_UNIDAD, formatearNumero } from '@/lib/computo/unidades';
import type { Origen, Unidad } from '@/types/domain';

/** Lo que la pantalla necesita de un ítem. Todo serializable: cruza al cliente. */
export interface ItemPlanilla {
  id: string;
  claveItem: string;
  descripcion: string;
  unidad: Unidad;
  cantNeta: number;
  desperdicioPct: number;
  cantCompra: number;
  presentacion: string;
  origen: Origen;
  confianza: number;
  anulado: boolean;
  /** `true` si alguien lo tocó a mano: el recómputo ya no lo pisa. */
  editado: boolean;
  /** Lámina de la primera fuente, para el link "Ver en plano". `null` si es manual. */
  laminaId: string | null;
  /**
   * La lámina sin escala verificada sobre la que se computó, o `null` si todas
   * sus fuentes están verificadas. Lo cruza la página (`escalaAsumidaDelItem`):
   * el número de esta fila puede estar tan afuera como lo esté la escala.
   */
  escalaAsumida: EscalaAsumida | null;
}

const ETIQUETA_ORIGEN: Record<Origen, string> = {
  explicito: 'Explícito',
  deducido: 'Deducido',
  supuesto: 'Supuesto',
};

const TONO_ORIGEN: Record<Origen, BadgeTone> = {
  explicito: 'ok',
  deducido: 'info',
  supuesto: 'warn',
};

/** Umbral de la regla de oro §11.b: por debajo, el dato se mira con lupa. */
const CONFIANZA_BAJA = 0.7;

export interface FilaItemProps {
  obraId: string;
  item: ItemPlanilla;
  /** `colaborador` o más (RF-1201). Con `lectura` la fila se mira y no se toca. */
  puedeEditar: boolean;
}

export function FilaItem({ obraId, item, puedeEditar }: FilaItemProps) {
  const [editando, setEditando] = useState(false);
  const [confirmandoAnulacion, setConfirmandoAnulacion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  const [descripcion, setDescripcion] = useState(item.descripcion);
  const [cantNeta, setCantNeta] = useState(formatearNumero(item.cantNeta));
  const [desperdicioPct, setDesperdicioPct] = useState(formatearNumero(item.desperdicioPct));

  function cancelar(): void {
    setDescripcion(item.descripcion);
    setCantNeta(formatearNumero(item.cantNeta));
    setDesperdicioPct(formatearNumero(item.desperdicioPct));
    setError(null);
    setEditando(false);
  }

  function guardar(): void {
    setError(null);
    iniciar(async () => {
      const resultado = await editarItemAction({
        obraId,
        itemId: item.id,
        descripcion,
        cantNeta,
        desperdicioPct,
      });
      if (resultado.ok) setEditando(false);
      else setError(resultado.error);
    });
  }

  function anular(): void {
    setError(null);
    iniciar(async () => {
      const resultado = await anularItemAction({ obraId, itemId: item.id });
      setConfirmandoAnulacion(false);
      if (!resultado.ok) setError(resultado.error);
    });
  }

  const claseFila = item.anulado ? 'bg-neutral-50 text-neutral-400' : undefined;

  return (
    <>
      <TableRow className={claseFila}>
        <TableCell>
          {editando ? (
            <Input
              aria-label="Descripción"
              value={descripcion}
              onChange={(evento) => setDescripcion(evento.target.value)}
              disabled={pendiente}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className={item.anulado ? 'line-through' : 'text-neutral-900'}>
                {item.descripcion}
              </span>
              {item.editado ? <Badge tone="info">Editado</Badge> : null}
              {item.anulado ? <Badge tone="neutral">Anulado</Badge> : null}
              {/* El aviso va acá y no en la bandeja porque acá está el número
                  que la escala asumida puede haber corrido. Lleva al visor de
                  esa lámina, que es donde se confirma o se corrige. */}
              {item.escalaAsumida ? (
                <Link
                  href={`/obras/${obraId}/laminas/${item.escalaAsumida.laminaId}`}
                  title={textoEscalaAsumida(item.escalaAsumida)}
                >
                  <Badge tone="warn">Escala asumida</Badge>
                </Link>
              ) : null}
            </div>
          )}
          <p className="mt-0.5 text-xs text-neutral-400">{item.claveItem}</p>
        </TableCell>

        <TableCell>{ETIQUETA_UNIDAD[item.unidad]}</TableCell>

        <TableCell numeric>
          {editando ? (
            <Input
              aria-label="Cantidad neta"
              inputMode="decimal"
              className="w-24 text-right"
              value={cantNeta}
              onChange={(evento) => setCantNeta(evento.target.value)}
              disabled={pendiente}
            />
          ) : (
            formatearNumero(item.cantNeta)
          )}
        </TableCell>

        <TableCell numeric>
          {editando ? (
            <Input
              aria-label="Desperdicio en porcentaje"
              inputMode="decimal"
              className="w-16 text-right"
              value={desperdicioPct}
              onChange={(evento) => setDesperdicioPct(evento.target.value)}
              disabled={pendiente}
            />
          ) : (
            formatearNumero(item.desperdicioPct)
          )}
        </TableCell>

        <TableCell numeric className="font-medium">
          {formatearNumero(item.cantCompra)}
        </TableCell>

        <TableCell>{item.presentacion}</TableCell>

        <TableCell>
          <Badge tone={TONO_ORIGEN[item.origen]}>{ETIQUETA_ORIGEN[item.origen]}</Badge>
        </TableCell>

        <TableCell numeric>
          <span className={item.confianza < CONFIANZA_BAJA ? 'text-amber-700' : undefined}>
            {Math.round(item.confianza * 100)}%
          </span>
        </TableCell>

        <TableCell>
          {item.laminaId ? (
            <Link
              href={`/obras/${obraId}/laminas/${item.laminaId}?highlight=${item.id}`}
              className="text-sm font-medium text-neutral-900 underline"
            >
              Ver en plano
            </Link>
          ) : (
            <span className="text-neutral-400">cargado a mano</span>
          )}
        </TableCell>

        <TableCell>
          {item.anulado || !puedeEditar ? (
            <span className="text-xs text-neutral-400">—</span>
          ) : editando ? (
            <div className="flex items-center gap-1">
              <Button size="sm" onClick={guardar} disabled={pendiente}>
                {pendiente ? 'Guardando…' : 'Guardar'}
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelar} disabled={pendiente}>
                Cancelar
              </Button>
            </div>
          ) : confirmandoAnulacion ? (
            <div className="flex items-center gap-1">
              <span className="text-xs text-neutral-600">¿Anular?</span>
              <Button size="sm" variant="danger" onClick={anular} disabled={pendiente}>
                Sí
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmandoAnulacion(false)}
                disabled={pendiente}
              >
                No
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="secondary" onClick={() => setEditando(true)}>
                Editar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmandoAnulacion(true)}>
                Anular
              </Button>
            </div>
          )}
        </TableCell>
      </TableRow>

      {error ? (
        <TableRow>
          <TableCell colSpan={10} className="bg-red-50 text-sm text-red-800">
            {error}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
