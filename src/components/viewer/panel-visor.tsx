'use client';

/**
 * El visor de una lámina, embebido al lado de otra cosa.
 *
 * El problema que resuelve: para verificar un dato que el sistema le pregunta,
 * el arquitecto tenía que hacer click en un link, esperar que cargara **otra**
 * página con el visor, mirar, volver atrás y recién ahí contestar. Con este
 * panel la consulta y el plano quedan lado a lado y el bbox se resalta sin
 * navegar.
 *
 * Es la pieza compartida: la bandeja de deducciones la usa hoy y la de
 * consultas la va a usar. Adentro va `VisorLamina` tal cual está —recibe bboxes
 * ya resueltos, no ids—; lo único que agrega este componente es de dónde salen
 * esas marcas.
 *
 * ## Por qué fetch y no props del server
 *
 * Bajar las marcas de **todas** las láminas de la obra en el render del server
 * sería un payload proporcional a la obra entera (25 láminas en la obra real)
 * para mirar una. Así que se piden por lámina, on-demand, a
 * `GET /api/laminas/[laminaId]/marcas`, y se cachean en memoria: volver a una
 * lámina ya vista es instantáneo y sin red. El caché vive en un `ref` —no en
 * estado— porque llenarlo no tiene que redibujar nada.
 *
 * El caché es por montaje del panel: no hay invalidación. Es correcto para lo
 * que dura una sesión de bandeja (mirar, decidir, seguir); si una acción cambia
 * las marcas, la pantalla se revalida y el panel se remonta.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { MarcasDeLamina } from '@/lib/pipeline/marcas';
import type { BBox } from '@/types/domain';

import { VisorLamina } from './visor-lamina';

export interface PanelVisorProps {
  /** Lámina a mostrar. `null` ⇒ todavía no eligieron nada: placeholder. */
  laminaId: string | null;
  /** Bbox a resaltar en rojo, ya resueltos (lo mismo que `?highlight=` deja). */
  destacados: readonly BBox[];
  /** Qué se está mirando: "A-01 · PLANTA PB", el nombre de la consulta. */
  etiqueta: string | null;
  /** Con `true` el panel se puede plegar (pantallas chicas, plano al final). */
  colapsable?: boolean;
}

type EstadoPanel = 'vacio' | 'cargando' | 'listo' | 'error';

function mensajeDe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Error desconocido.';
}

export function PanelVisor({ laminaId, destacados, etiqueta, colapsable = false }: PanelVisorProps) {
  const cache = useRef(new Map<string, MarcasDeLamina>());
  const [marcas, setMarcas] = useState<MarcasDeLamina | null>(null);
  const [estado, setEstado] = useState<EstadoPanel>('vacio');
  const [detalleError, setDetalleError] = useState('');
  const [plegado, setPlegado] = useState(false);
  /** Sube en cada "Reintentar": vuelve a correr el efecto sin tocar la lámina. */
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (laminaId === null) {
      setMarcas(null);
      setEstado('vacio');
      return;
    }

    const guardadas = cache.current.get(laminaId);
    if (guardadas) {
      setMarcas(guardadas);
      setEstado('listo');
      return;
    }

    // Cambiar de lámina cancela el pedido anterior: una respuesta vieja no
    // puede pisar a la que se está mirando ahora.
    let cancelado = false;
    const corte = new AbortController();

    async function traer(id: string): Promise<void> {
      setEstado('cargando');
      setDetalleError('');
      try {
        const respuesta = await fetch(`/api/laminas/${encodeURIComponent(id)}/marcas`, {
          signal: corte.signal,
        });
        if (!respuesta.ok) {
          const cuerpo = (await respuesta.json().catch(() => null)) as { error?: string } | null;
          throw new Error(cuerpo?.error ?? 'No pude traer las marcas de la lámina.');
        }
        const datos = (await respuesta.json()) as MarcasDeLamina;
        cache.current.set(id, datos);
        if (cancelado) return;
        setMarcas(datos);
        setEstado('listo');
      } catch (error) {
        if (cancelado) return;
        setDetalleError(mensajeDe(error));
        setEstado('error');
      }
    }

    void traer(laminaId);
    return () => {
      cancelado = true;
      corte.abort();
    };
  }, [laminaId, intento]);

  const reintentar = useCallback(() => {
    if (laminaId !== null) cache.current.delete(laminaId);
    setIntento((valor) => valor + 1);
  }, [laminaId]);

  return (
    <section className="flex flex-col gap-2" aria-label="Plano de la consulta">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
          {etiqueta ?? 'Plano'}
        </h2>
        {colapsable ? (
          <button
            type="button"
            onClick={() => setPlegado((valor) => !valor)}
            aria-expanded={!plegado}
            className="text-xs font-medium text-neutral-600 underline hover:text-neutral-900"
          >
            {plegado ? 'Mostrar el plano' : 'Ocultar el plano'}
          </button>
        ) : null}
      </div>

      {plegado ? null : (
        <>
          {estado === 'vacio' ? (
            <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-16 text-center">
              <p className="text-sm text-neutral-600">Elegí una consulta para ver el plano</p>
            </div>
          ) : null}

          {estado === 'cargando' ? (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-16 text-center">
              <p className="text-sm text-neutral-500">Buscando la lámina…</p>
            </div>
          ) : null}

          {estado === 'error' ? (
            <div className="flex flex-col items-start gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-6">
              <p className="text-sm font-medium text-neutral-900">
                No pude traer las marcas de esta lámina.
              </p>
              <p className="text-xs text-neutral-500">Detalle técnico: {detalleError}</p>
              <button
                type="button"
                onClick={reintentar}
                className="text-sm font-medium text-neutral-900 underline"
              >
                Reintentar
              </button>
            </div>
          ) : null}

          {estado === 'listo' && marcas ? (
            <VisorLamina
              // Cambiar de lámina remonta el visor: pdf.js no reusa nada entre
              // documentos y el estado de las capas no tiene por qué arrastrarse.
              key={marcas.laminaId}
              archivoUrl={marcas.archivoUrl}
              entidades={marcas.entidades}
              hallazgos={marcas.hallazgos}
              deducciones={marcas.deducciones}
              destacados={destacados}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
