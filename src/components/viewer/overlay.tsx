'use client';

/**
 * Capa de anotaciones sobre la lámina (provenance visible, P1).
 *
 * Los bbox del dominio son normalizados 0–1 sobre la página, así que el SVG usa
 * `viewBox="0 0 1 1"` con `preserveAspectRatio="none"`: cada `[x, y, w, h]` se
 * dibuja tal cual, sin convertir a píxeles y sin depender de la escala a la que
 * pdf.js haya rasterizado la página. Los trazos llevan
 * `vector-effect="non-scaling-stroke"` para que ese estiramiento no deforme el
 * grosor de las líneas.
 *
 * Los pines de consulta (⚠) son HTML posicionado en porcentajes, no `<text>`
 * dentro del SVG: dentro del viewBox estirado, un glifo saldría deformado.
 */
import { useEffect, useRef } from 'react';

import type { BBox, TipoEntidad } from '@/types/domain';

export interface MarcaEntidad {
  id: string;
  tipo: TipoEntidad;
  nombre: string;
  /** Lo que dice la fuente de esa zona ("Dormitorio 1: 12,5 m²"). */
  detalle?: string;
  bbox: BBox;
}

export interface MarcaHallazgo {
  id: string;
  descripcion: string;
  bloqueante: boolean;
  bbox: BBox;
}

/**
 * Una deducción propuesta, dibujada sobre el bbox de la entidad que
 * **completaría** —no sobre la que aporta el dato—: lo que el arquitecto tiene
 * que mirar es el elemento que hoy está sin acotar.
 */
export interface MarcaDeduccion {
  id: string;
  /** "ancho", "altura" — el campo en castellano. */
  campo: string;
  /** "1,50 m" — el valor ya escrito para leer. */
  valor: string;
  /** "Planilla ↔ plano". */
  regla: string;
  bbox: BBox;
}

export interface OverlayProps {
  entidades: readonly MarcaEntidad[];
  hallazgos: readonly MarcaHallazgo[];
  deducciones: readonly MarcaDeduccion[];
  /** Bbox del target de `?highlight=…`: rect rojo grueso + scroll hasta él. */
  destacados: readonly BBox[];
  verEntidades: boolean;
  verHallazgos: boolean;
  verDeducciones: boolean;
}

/** Un color por tipo de entidad: el mismo que usa la referencia del visor. */
export const COLOR_ENTIDAD: Record<TipoEntidad, string> = {
  ambiente: '#0284c7',
  muro: '#b45309',
  tabique: '#7c3aed',
  abertura: '#059669',
  artefacto: '#db2777',
  terminacion: '#0891b2',
  // Las cotas son la referencia dimensional, no una cosa construida: gris cálido
  // para que se lean como anotación y no compitan con muros y aberturas.
  cota: '#a16207',
  otro: '#525252',
};

export const ETIQUETA_TIPO_ENTIDAD: Record<TipoEntidad, string> = {
  ambiente: 'Ambiente',
  muro: 'Muro',
  tabique: 'Tabique',
  abertura: 'Abertura',
  artefacto: 'Artefacto',
  terminacion: 'Terminación',
  cota: 'Cota',
  otro: 'Otro',
};

const ROJO_DESTACADO = '#dc2626';

/**
 * Violeta de la capa de deducciones. El trazo va **punteado** y sin relleno: lo
 * cortado dice "esto todavía no está escrito en el plano".
 *
 * Es el mismo violeta que el de `tabique`, que es lo que hay en la paleta; lo
 * que separa las dos marcas es el trazo (el de entidad es continuo y con
 * relleno) y, sobre todo, que son capas distintas y se prenden por separado.
 * Cada rect lleva además su tooltip con campo, valor y regla.
 */
export const VIOLETA_DEDUCCION = '#7c3aed';

function porcentaje(valor: number): string {
  return `${(valor * 100).toFixed(3)}%`;
}

export function Overlay({
  entidades,
  hallazgos,
  deducciones,
  destacados,
  verEntidades,
  verHallazgos,
  verDeducciones,
}: OverlayProps) {
  const anclaRef = useRef<HTMLDivElement>(null);

  // RF-303: al llegar desde la planilla, la zona citada tiene que quedar a la
  // vista sin que el arquitecto la busque.
  useEffect(() => {
    if (destacados.length === 0) return;
    anclaRef.current?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }, [destacados]);

  const primero = destacados[0];

  return (
    <div className="pointer-events-none absolute inset-0">
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        {verEntidades
          ? entidades.map((entidad, indice) => (
              <rect
                key={`${entidad.id}-${indice}`}
                x={entidad.bbox[0]}
                y={entidad.bbox[1]}
                width={entidad.bbox[2]}
                height={entidad.bbox[3]}
                fill={COLOR_ENTIDAD[entidad.tipo]}
                fillOpacity={0.08}
                stroke={COLOR_ENTIDAD[entidad.tipo]}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              >
                <title>
                  {`${entidad.nombre} · ${ETIQUETA_TIPO_ENTIDAD[entidad.tipo]}`}
                  {entidad.detalle && entidad.detalle !== entidad.nombre
                    ? ` — ${entidad.detalle}`
                    : ''}
                </title>
              </rect>
            ))
          : null}

        {verHallazgos
          ? hallazgos.map((hallazgo, indice) => (
              <rect
                key={`${hallazgo.id}-${indice}`}
                x={hallazgo.bbox[0]}
                y={hallazgo.bbox[1]}
                width={hallazgo.bbox[2]}
                height={hallazgo.bbox[3]}
                fill="#f59e0b"
                fillOpacity={0.1}
                stroke="#b45309"
                strokeWidth={1.5}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              >
                <title>{hallazgo.descripcion}</title>
              </rect>
            ))
          : null}

        {verDeducciones
          ? deducciones.map((deduccion, indice) => (
              <rect
                key={`${deduccion.id}-${indice}`}
                x={deduccion.bbox[0]}
                y={deduccion.bbox[1]}
                width={deduccion.bbox[2]}
                height={deduccion.bbox[3]}
                fill="none"
                stroke={VIOLETA_DEDUCCION}
                strokeWidth={2}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${deduccion.campo} = ${deduccion.valor} (${deduccion.regla})`}</title>
              </rect>
            ))
          : null}

        {destacados.map((bbox, indice) => (
          <rect
            key={`destacado-${indice}`}
            x={bbox[0]}
            y={bbox[1]}
            width={bbox[2]}
            height={bbox[3]}
            fill="none"
            stroke={ROJO_DESTACADO}
            strokeWidth={3}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      {/* Pines de consulta: HTML, para que el ⚠ no se deforme con el viewBox. */}
      {verHallazgos
        ? hallazgos.map((hallazgo, indice) => (
            <span
              key={`pin-${hallazgo.id}-${indice}`}
              title={hallazgo.descripcion}
              className={[
                'pointer-events-auto absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-xs shadow-sm',
                hallazgo.bloqueante
                  ? 'border-red-700 bg-red-600 text-white'
                  : 'border-amber-600 bg-amber-100 text-amber-900',
              ].join(' ')}
              style={{
                left: porcentaje(hallazgo.bbox[0] + hallazgo.bbox[2]),
                top: porcentaje(hallazgo.bbox[1]),
              }}
            >
              <span aria-hidden="true">⚠</span>
              <span className="sr-only">{hallazgo.descripcion}</span>
            </span>
          ))
        : null}

      {/* Ancla invisible del destacado: es lo que se lleva el scroll. */}
      {primero ? (
        <div
          ref={anclaRef}
          className="absolute h-0 w-0"
          style={{
            left: porcentaje(primero[0] + primero[2] / 2),
            top: porcentaje(primero[1] + primero[3] / 2),
          }}
        />
      ) : null}
    </div>
  );
}
