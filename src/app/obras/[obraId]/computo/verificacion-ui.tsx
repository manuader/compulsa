'use client';

/**
 * "Verificar cómputo": la doble pasada, desde la planilla (RF-306).
 *
 * Un botón y lo que vuelve. La honestidad del panel está en dos detalles:
 *
 *  - **el resultado bueno también se muestra**. "Las dos lecturas coincidieron"
 *    es información: es la que le permite al arquitecto mandar a comprar. Un
 *    panel que solo aparece cuando hay problemas deja al que no ve nada sin
 *    saber si verificó o no;
 *  - **las diferencias no bloquean**. Son consultas de la bandeja, y el texto lo
 *    dice: el cómputo sigue siendo el que salió de la documentación, pero hay
 *    dos lecturas que no coinciden y alguien tiene que mirar la lámina.
 *
 * Cliente porque hay interactividad real (`src/app/CLAUDE.md` §2). El rol lo
 * vuelve a exigir el core: el botón deshabilitado es cortesía, no seguridad.
 */
import Link from 'next/link';
import { useState, useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

import { verificarComputoAction, type DiferenciaVista } from './verificacion-actions';

/** Una consulta `verificacion.*` que quedó abierta de una corrida anterior. */
export interface ConsultaVerificacionVista {
  clave: string;
  descripcion: string;
}

interface Corrida {
  laminasLeidas: number;
  itemsComparados: number;
  diferencias: DiferenciaVista[];
}

const ETIQUETA_MOTIVO: Record<DiferenciaVista['motivo'], string> = {
  desvio: 'Cantidad distinta',
  solo_computo: 'Falta en la segunda lectura',
  solo_verificacion: 'Falta en el cómputo',
};

export interface VerificacionComputoProps {
  obraId: string;
  /** `false` para el rol lectura: el botón se ve deshabilitado y explicado. */
  puedeVerificar: boolean;
  /** Consultas abiertas de verificaciones anteriores. */
  consultasAbiertas: ConsultaVerificacionVista[];
}

export function VerificacionComputo({
  obraId,
  puedeVerificar,
  consultasAbiertas,
}: VerificacionComputoProps) {
  const [corrida, setCorrida] = useState<Corrida | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  function verificar(): void {
    setError(null);
    iniciar(async () => {
      const resultado = await verificarComputoAction({ obraId });
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      setCorrida({
        laminasLeidas: resultado.laminasLeidas,
        itemsComparados: resultado.itemsComparados,
        diferencias: resultado.diferencias,
      });
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-neutral-900">Verificar cómputo</h3>
          <p className="text-sm text-neutral-600">
            Vuelve a leer las láminas y compara contra esta planilla. Lo que no coincida queda como
            consulta en la bandeja, sin bloquear la aprobación.
          </p>
        </div>
        <Button onClick={verificar} disabled={pendiente || !puedeVerificar}>
          {pendiente ? 'Releyendo las láminas…' : 'Verificar cómputo'}
        </Button>
      </CardHeader>

      {!puedeVerificar || error || corrida || consultasAbiertas.length > 0 ? (
        <CardContent className="flex flex-col gap-3">
          {!puedeVerificar ? (
            <p className="text-sm text-neutral-600">
              Tu rol es solo lectura: podés mirar el resultado de la última verificación, pero no
              lanzar una nueva.
            </p>
          ) : null}

          {error ? <p className="text-sm text-red-700">{error}</p> : null}

          {corrida ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-neutral-700">
                Se releyeron {corrida.laminasLeidas}{' '}
                {corrida.laminasLeidas === 1 ? 'lámina' : 'láminas'} y se compararon{' '}
                {corrida.itemsComparados} {corrida.itemsComparados === 1 ? 'ítem' : 'ítems'}.{' '}
                {corrida.diferencias.length === 0
                  ? 'Las dos lecturas coincidieron en todo.'
                  : `${corrida.diferencias.length} ${
                      corrida.diferencias.length === 1 ? 'diferencia' : 'diferencias'
                    }.`}
              </p>

              {corrida.diferencias.length > 0 ? (
                <>
                  <ul className="flex flex-col gap-2">
                    {corrida.diferencias.map((diferencia) => (
                      <li
                        key={diferencia.clave}
                        className="flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-2 text-sm first:border-t-0 first:pt-0"
                      >
                        <Badge tone="warn">{ETIQUETA_MOTIVO[diferencia.motivo]}</Badge>
                        <span className="font-medium text-neutral-900">
                          {diferencia.descripcion}
                        </span>
                        <span className="text-neutral-700 tabular-nums">
                          {diferencia.antes} → {diferencia.despues}
                          {diferencia.desvio !== null ? ` (${diferencia.desvio})` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-sm">
                    <Link
                      href={`/obras/${obraId}/bandeja`}
                      className="font-medium text-neutral-900 underline"
                    >
                      Resolverlas en la bandeja
                    </Link>
                  </p>
                </>
              ) : null}
            </div>
          ) : consultasAbiertas.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-neutral-700">
                La última verificación dejó {consultasAbiertas.length}{' '}
                {consultasAbiertas.length === 1 ? 'consulta abierta' : 'consultas abiertas'}:
              </p>
              <ul className="flex flex-col gap-1 text-sm text-neutral-700">
                {consultasAbiertas.map((consulta) => (
                  <li key={consulta.clave}>{consulta.descripcion}</li>
                ))}
              </ul>
              <p className="text-sm">
                <Link
                  href={`/obras/${obraId}/bandeja`}
                  className="font-medium text-neutral-900 underline"
                >
                  Resolverlas en la bandeja
                </Link>
              </p>
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
