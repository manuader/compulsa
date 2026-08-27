'use client';

/**
 * Tarjetas de la bandeja de deducciones.
 *
 * Una tarjeta por **elemento** (el tabique T1, la ventana V2), no por deducción
 * y ni siquiera por entidad. El motivo es la simetría de las reglas: el mismo
 * tabique dibujado en la planta y en el corte genera propuestas **en las dos
 * direcciones** —la planta recibe la altura del corte y el corte recibe el largo
 * de la planta—, y listadas sueltas parecen la misma sugerencia repetida. Puestas
 * bajo un solo título, con el nombre de su lámina al lado, se leen por lo que
 * son: dos dibujos del mismo elemento completándose entre sí. La tarjeta lo dice
 * con todas las letras cuando pasa.
 *
 * Cada fila trae lo necesario para decidir sin salir de la pantalla: qué campo,
 * qué valor, con qué regla, por qué, con cuánta confianza y en qué láminas está.
 * Validar pide confirmación —escribe un dato en la documentación derivada— y
 * rechazar no.
 *
 * ## El plano al lado, no a un click de distancia
 *
 * "Sin salir de la pantalla" era mentira a medias: para mirar el dibujo había
 * que hacer click, esperar que cargara la página del visor, mirar, volver atrás
 * y recién ahí decidir. Ahora la lista comparte la pantalla con un `PanelVisor`
 * a la derecha (apilado en pantallas chicas) y elegir una lámina citada la carga
 * ahí, con los bbox de la deducción resaltados y sin navegar.
 *
 * Los `?highlight=` no se van: el contrato de `src/app/CLAUDE.md` §4 sigue
 * intacto y cada propuesta ofrece "Abrir en página completa" para cuando el
 * plano necesita toda la pantalla.
 */
import Link from 'next/link';
import { useState, useTransition } from 'react';

import {
  rechazarDeduccionAction,
  validarDeduccionAction,
} from '@/app/obras/[obraId]/deducciones/actions';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PanelVisor } from '@/components/viewer/panel-visor';
import type { BBox, ReglaDeduccion } from '@/types/domain';

// ---------------------------------------------------------------------------
// Datos que baja el server (todo serializable)
// ---------------------------------------------------------------------------

export interface LaminaCitada {
  laminaId: string;
  etiqueta: string;
}

/** Una zona citada por la deducción: lámina + bbox normalizado (P1). */
export interface FuenteDeduccion {
  laminaId: string;
  bbox: BBox;
}

export interface DeduccionVista {
  id: string;
  campo: string;
  /** "ancho", "altura" — el campo en castellano. */
  etiqueta: string;
  /** "1,50 m", "2" — el valor ya escrito para leer. */
  valor: string;
  regla: ReglaDeduccion;
  tituloRegla: string;
  explicacion: string;
  /** 0–1. Por debajo de 0,70 el motor ni la propone. */
  confianza: number;
  laminas: LaminaCitada[];
  /** Los bbox que la sostienen, para resaltarlos en el panel de al lado. */
  fuentes: FuenteDeduccion[];
}

/** El elemento visto en UNA lámina, con lo que esa lámina no dice. */
export interface VistaEnLamina {
  entidadId: string;
  laminaId: string;
  /** "A-01 · PLANTA PB". */
  lamina: string;
  deducciones: DeduccionVista[];
}

/** El mismo elemento (tipo + nombre), esté en la lámina que esté. */
export interface GrupoElemento {
  clave: string;
  /** "Abertura V2", "Tabique T1". */
  titulo: string;
  vistas: VistaEnLamina[];
}

// ---------------------------------------------------------------------------

/** Verde ≥ 0,90, ámbar ≥ 0,80, gris el resto (nunca baja de 0,70: el motor corta ahí). */
function tonoConfianza(confianza: number): BadgeTone {
  if (confianza >= 0.9) return 'ok';
  if (confianza >= 0.8) return 'warn';
  return 'neutral';
}

function porcentaje(confianza: number): string {
  return `${Math.round(confianza * 100)}%`;
}

/**
 * El `destacados` de "no hay nada elegido", **una sola vez**.
 *
 * Un `?? []` allá abajo sería un array nuevo por render: `Overlay` scrollea con
 * un `useEffect(…, [destacados])` y volvería a scrollear en cada uno. Es la
 * misma constante de módulo que la bandeja (T5b), por el mismo motivo.
 */
const SIN_DESTACADOS: readonly BBox[] = [];

/** Lo que el panel de la derecha está mostrando. */
export interface Seleccion {
  deduccionId: string;
  laminaId: string;
  destacados: BBox[];
  etiqueta: string;
}

/**
 * La selección que sigue siendo válida, o `null`.
 *
 * Validar o rechazar revalida la pantalla y la propuesta desaparece de la
 * lista: dejar el plano abierto con «A-01 · PLANTA REFORMA · alto = 1,00 m» de
 * una deducción que ya se validó es mostrar una decisión que ya se tomó. Es el
 * mismo guard de "no fantasmas" que la bandeja (`miradaVigente`), y por el
 * mismo motivo se filtra **en el render** y no se limpia el estado: volver al
 * filtro de regla donde la deducción vive la vuelve a mostrar.
 */
export function seleccionVigente(
  seleccion: Seleccion | null,
  grupos: readonly GrupoElemento[],
): Seleccion | null {
  if (seleccion === null) return null;
  const sigue = grupos.some((grupo) =>
    grupo.vistas.some((vista) =>
      vista.deducciones.some((deduccion) => deduccion.id === seleccion.deduccionId),
    ),
  );
  return sigue ? seleccion : null;
}

interface FilaProps {
  obraId: string;
  deduccion: DeduccionVista;
  /** `null` si la seleccionada es otra (o si no hay ninguna). */
  laminaActiva: string | null;
  onVer: (deduccion: DeduccionVista, lamina: LaminaCitada) => void;
}

function FilaDeduccion({ obraId, deduccion, laminaActiva, onVer }: FilaProps) {
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  function correr(accion: () => Promise<{ ok: true } | { ok: false; error: string }>): void {
    setError(null);
    setConfirmando(false);
    iniciar(async () => {
      const resultado = await accion();
      if (!resultado.ok) setError(resultado.error);
    });
  }

  return (
    <li
      className={[
        'flex flex-col gap-2 border-t border-neutral-200 py-3 first:border-t-0 first:pt-0',
        // La que se está mirando en el panel, marcada: con varias propuestas
        // abiertas hay que saber de cuál es el bbox rojo de la derecha.
        laminaActiva === null ? '' : '-mx-2 rounded-md bg-neutral-50 px-2',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-neutral-900">
          {deduccion.etiqueta} = {deduccion.valor}
        </span>
        <Badge tone="info">{deduccion.tituloRegla}</Badge>
        <Badge tone={tonoConfianza(deduccion.confianza)} title="Confianza de la deducción">
          {porcentaje(deduccion.confianza)}
        </Badge>
      </div>

      <p className="text-sm text-neutral-700">{deduccion.explicacion}</p>

      {/* Cada lámina citada es un botón, no un link: carga el plano en el panel
          de al lado sin sacar al arquitecto de la decisión que está tomando. El
          link a la página completa queda al final, para cuando el plano necesita
          toda la pantalla (contrato `?highlight=`, app/CLAUDE.md §4). */}
      {deduccion.laminas.length > 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral-500">Se apoya en:</span>
          {deduccion.laminas.map((lamina) => {
            const activa = laminaActiva === lamina.laminaId;
            return (
              <button
                key={lamina.laminaId}
                type="button"
                aria-pressed={activa}
                onClick={() => onVer(deduccion, lamina)}
                className={[
                  'rounded-full border px-2 py-0.5 font-medium transition-colors',
                  activa
                    ? 'border-neutral-900 bg-neutral-900 text-white'
                    : 'border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100',
                ].join(' ')}
              >
                {lamina.etiqueta}
              </button>
            );
          })}
          <Link
            href={`/obras/${obraId}/laminas/${deduccion.laminas[0]!.laminaId}?highlight=${deduccion.id}`}
            className="text-neutral-600 underline hover:text-neutral-900"
          >
            Abrir en página completa
          </Link>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {confirmando ? (
          <span className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-neutral-600">
              Se escribe {deduccion.etiqueta} = {deduccion.valor} en el elemento. ¿Va?
            </span>
            <Button
              size="sm"
              onClick={() => correr(() => validarDeduccionAction({ obraId, deduccionId: deduccion.id }))}
              disabled={pendiente}
            >
              Sí, validar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmando(false)} disabled={pendiente}>
              No
            </Button>
          </span>
        ) : (
          <Button size="sm" onClick={() => setConfirmando(true)} disabled={pendiente}>
            Validar
          </Button>
        )}

        <Button
          size="sm"
          variant="secondary"
          onClick={() => correr(() => rechazarDeduccionAction({ obraId, deduccionId: deduccion.id }))}
          disabled={pendiente}
        >
          Rechazar
        </Button>
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------

export interface BandejaDeduccionesProps {
  obraId: string;
  grupos: GrupoElemento[];
  /** `true` si el filtro por regla está activo: cambia el texto del vacío. */
  filtrada: boolean;
}

export function BandejaDeducciones({ obraId, grupos, filtrada }: BandejaDeduccionesProps) {
  const [seleccion, setSeleccion] = useState<Seleccion | null>(null);

  // La deducción que el panel muestra tiene que seguir estando en la lista
  // (`seleccionVigente`, pinneada en `tests/unit/deducciones-plano.test.ts`).
  const enPanel = seleccionVigente(seleccion, grupos);

  /**
   * Elegir una lámina citada. Los destacados son los bbox de **esa** lámina: una
   * deducción de planilla ↔ plano cita dos, y el panel muestra una por vez.
   */
  function ver(deduccion: DeduccionVista, lamina: LaminaCitada): void {
    setSeleccion({
      deduccionId: deduccion.id,
      laminaId: lamina.laminaId,
      destacados: deduccion.fuentes
        .filter((fuente) => fuente.laminaId === lamina.laminaId)
        .map((fuente) => fuente.bbox),
      etiqueta: `${lamina.etiqueta} · ${deduccion.etiqueta} = ${deduccion.valor}`,
    });
  }

  if (grupos.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-neutral-900">
          {filtrada ? 'Ninguna deducción de esa regla.' : 'No hay deducciones para validar.'}
        </p>
        <p className="mt-1 text-sm text-neutral-600">
          {filtrada
            ? 'Probá con otra regla o mirá todas.'
            : 'Aparecen solas cuando dos láminas dicen entre las dos algo que ninguna dice sola: una planilla de carpinterías y una planta, un corte y una planta.'}
        </p>
      </div>
    );
  }

  return (
    // Dos columnas desde `lg`: la lista a la izquierda y el plano a la derecha,
    // pegado al scroll. Apilado en pantallas chicas, con el panel plegable para
    // que no empuje la lista fuera de la vista.
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        {grupos.map((grupo) => (
          <Card key={grupo.clave}>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-sm font-semibold text-neutral-900">{grupo.titulo}</h2>
                <span className="text-xs text-neutral-500 tabular-nums">
                  {grupo.vistas.reduce((total, vista) => total + vista.deducciones.length, 0)}{' '}
                  {grupo.vistas.reduce((total, vista) => total + vista.deducciones.length, 0) === 1
                    ? 'dato'
                    : 'datos'}
                </span>
              </div>

              {/* La simetría explicada donde aparece, no en un manual: dos
                  láminas del mismo elemento completándose no son duplicación. */}
              {grupo.vistas.length > 1 ? (
                <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
                  Este elemento está dibujado en {grupo.vistas.length} láminas y cada una completa
                  lo que la otra no dice. No es la misma deducción repetida: validá la que
                  corresponda a la lámina desde la que computás.
                </p>
              ) : null}

              {grupo.vistas.map((vista) => (
                <section key={vista.entidadId} className="flex flex-col gap-1">
                  <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                    <Link
                      href={`/obras/${obraId}/laminas/${vista.laminaId}?highlight=${vista.entidadId}`}
                      className="underline"
                    >
                      {vista.lamina}
                    </Link>
                  </p>
                  <ul className="flex flex-col">
                    {vista.deducciones.map((deduccion) => (
                      <FilaDeduccion
                        key={deduccion.id}
                        obraId={obraId}
                        deduccion={deduccion}
                        laminaActiva={
                          enPanel?.deduccionId === deduccion.id ? enPanel.laminaId : null
                        }
                        onVer={ver}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="min-w-0 lg:sticky lg:top-4">
        <PanelVisor
          laminaId={enPanel?.laminaId ?? null}
          destacados={enPanel?.destacados ?? SIN_DESTACADOS}
          etiqueta={enPanel?.etiqueta ?? null}
          colapsable
        />
      </div>
    </div>
  );
}
