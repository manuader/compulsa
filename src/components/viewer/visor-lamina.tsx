'use client';

/**
 * Visor de una lámina: pdf.js rasteriza la página a un `<canvas>` y encima va el
 * overlay de entidades y consultas.
 *
 * Es el único componente del workspace que necesita el browser de verdad
 * (`src/app/CLAUDE.md` §2): pdf.js se importa dinámicamente **dentro del
 * efecto**, así el módulo no se evalúa durante el render en el server.
 *
 * El worker se sirve como archivo estático desde `public/pdf.worker.min.mjs`
 * (copia commiteada de `pdfjs-dist/legacy/build/pdf.worker.min.mjs`, pineado en
 * 4.10.38). Es la variante que compila con el bundler de Next sin tocar
 * `next.config.ts` ni `package.json`; si algún día se actualiza pdfjs-dist hay
 * que actualizar la copia.
 */
import { useEffect, useRef, useState } from 'react';

import type { BBox } from '@/types/domain';

import {
  COLOR_ENTIDAD,
  ETIQUETA_TIPO_ENTIDAD,
  Overlay,
  VIOLETA_DEDUCCION,
  type MarcaDeduccion,
  type MarcaEntidad,
  type MarcaHallazgo,
} from './overlay';

const WORKER_SRC = '/pdf.worker.min.mjs';

/** Tope del devicePixelRatio: en pantallas 3x un plano A1 hace explotar la RAM. */
const DPR_MAXIMO = 2;

/** Ancho de rasterizado si el contenedor todavía no tiene layout. */
const ANCHO_POR_DEFECTO = 900;

export interface VisorLaminaProps {
  /** Ruta a los bytes de la lámina: `/api/archivos/<archivoRef>`. */
  archivoUrl: string;
  entidades: readonly MarcaEntidad[];
  hallazgos: readonly MarcaHallazgo[];
  /** Deducciones propuestas cuyo elemento se dibuja en esta lámina. */
  deducciones: readonly MarcaDeduccion[];
  /** Bbox del target de `?highlight=…`. */
  destacados: readonly BBox[];
}

type EstadoVisor = 'cargando' | 'listo' | 'error';

function mensajeDeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Error desconocido.';
}

export function VisorLamina({
  archivoUrl,
  entidades,
  hallazgos,
  deducciones,
  destacados,
}: VisorLaminaProps) {
  const contenedorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [estado, setEstado] = useState<EstadoVisor>('cargando');
  const [detalleError, setDetalleError] = useState<string>('');
  const [verEntidades, setVerEntidades] = useState(true);
  const [verHallazgos, setVerHallazgos] = useState(true);
  // Prendida cuando hay algo que mostrar: si la obra tiene deducciones
  // esperando, que se vean sin que nadie tenga que descubrir el checkbox.
  const [verDeducciones, setVerDeducciones] = useState(deducciones.length > 0);
  const [ancho, setAncho] = useState(0);
  /** Ancho con el que se rasterizó lo que está en pantalla. */
  const anchoUsadoRef = useRef(0);

  // El redibujado por resize es una mejora, no un requisito: si el contenedor
  // todavía no tiene layout (pestaña en segundo plano, panel plegado) el visor
  // dibuja igual con el ancho por defecto y se reajusta cuando haya medida. Solo
  // un cambio grande vuelve a rasterizar: un par de píxeles no lo justifican.
  useEffect(() => {
    const contenedor = contenedorRef.current;
    if (!contenedor) return;

    const observador = new ResizeObserver((entradas) => {
      const medido = Math.round(entradas[0]?.contentRect.width ?? 0);
      if (medido <= 0) return;
      const usado = anchoUsadoRef.current;
      if (usado === 0 || Math.abs(medido - usado) > usado * 0.15) setAncho(medido);
    });
    observador.observe(contenedor);
    return () => observador.disconnect();
  }, []);

  useEffect(() => {
    let cancelado = false;
    let documento: { destroy: () => Promise<void> } | null = null;
    let tarea: { cancel: () => void } | null = null;

    async function dibujar(): Promise<void> {
      setEstado('cargando');
      setDetalleError('');
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;

        const pdf = await pdfjs.getDocument({ url: archivoUrl, isEvalSupported: false }).promise;
        documento = pdf;
        if (cancelado) return;

        const pagina = await pdf.getPage(1);
        const canvas = canvasRef.current;
        const contexto = canvas?.getContext('2d');
        if (cancelado || !canvas || !contexto) return;

        const base = pagina.getViewport({ scale: 1 });
        const util = ancho || contenedorRef.current?.clientWidth || ANCHO_POR_DEFECTO;
        anchoUsadoRef.current = util;
        const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAXIMO);
        const viewport = pagina.getViewport({ scale: (util / base.width) * dpr });

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        // La tarea se guarda para poder cancelarla: dos render() sobre el mismo
        // canvas (redibujado por resize, doble efecto de StrictMode) se pisan y
        // dejan la lámina en blanco.
        const dibujo = pagina.render({ canvasContext: contexto, viewport });
        tarea = dibujo;
        await dibujo.promise;
        if (cancelado) return;

        setEstado('listo');
      } catch (error) {
        if (cancelado) return;
        setDetalleError(mensajeDeError(error));
        setEstado('error');
      }
    }

    void dibujar();
    return () => {
      cancelado = true;
      tarea?.cancel();
      void documento?.destroy();
    };
  }, [archivoUrl, ancho]);

  const tiposPresentes = [...new Set(entidades.map((entidad) => entidad.tipo))].sort();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-neutral-200 bg-white px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-neutral-500 uppercase">Capas</span>

        <label className="flex items-center gap-2 text-sm text-neutral-800">
          <input
            type="checkbox"
            checked={verEntidades}
            onChange={(evento) => setVerEntidades(evento.target.checked)}
            className="h-4 w-4"
          />
          Entidades ({entidades.length})
        </label>

        <label className="flex items-center gap-2 text-sm text-neutral-800">
          <input
            type="checkbox"
            checked={verHallazgos}
            onChange={(evento) => setVerHallazgos(evento.target.checked)}
            className="h-4 w-4"
          />
          Consultas ({hallazgos.length})
        </label>

        {/* La capa solo existe si hay deducciones: un checkbox en cero es ruido. */}
        {deducciones.length > 0 ? (
          <label className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={verDeducciones}
              onChange={(evento) => setVerDeducciones(evento.target.checked)}
              className="h-4 w-4"
            />
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-dashed"
                style={{ borderColor: VIOLETA_DEDUCCION }}
              />
              Deducciones ({deducciones.length})
            </span>
          </label>
        ) : null}

        {verEntidades && tiposPresentes.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-3">
            {tiposPresentes.map((tipo) => (
              <li key={tipo} className="flex items-center gap-1.5 text-xs text-neutral-600">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: COLOR_ENTIDAD[tipo] }}
                />
                {ETIQUETA_TIPO_ENTIDAD[tipo]}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div
        ref={contenedorRef}
        className="relative w-full overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50"
      >
        {/* Con error el canvas se esconde: un rectángulo vacío arriba del
            mensaje solo confunde. */}
        <canvas ref={canvasRef} className={estado === 'error' ? 'hidden' : 'block h-auto w-full'} />

        {estado === 'listo' ? (
          <Overlay
            entidades={entidades}
            hallazgos={hallazgos}
            deducciones={deducciones}
            destacados={destacados}
            verEntidades={verEntidades}
            verHallazgos={verHallazgos}
            verDeducciones={verDeducciones}
          />
        ) : null}

        {estado === 'cargando' ? (
          <p className="px-4 py-16 text-center text-sm text-neutral-500">Dibujando la lámina…</p>
        ) : null}

        {estado === 'error' ? (
          <div className="flex flex-col items-start gap-2 px-4 py-10">
            <p className="text-sm font-medium text-neutral-900">No pude dibujar la lámina.</p>
            <p className="text-sm text-neutral-600">
              Puede que el archivo todavía no esté disponible en el servidor. Probá recargar; si
              sigue igual, abrí el PDF directo para ver si el archivo está.
            </p>
            <p className="text-xs text-neutral-500">Detalle técnico: {detalleError}</p>
            <a
              href={archivoUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-neutral-900 underline"
            >
              Abrir el PDF en otra pestaña
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
