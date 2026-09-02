'use client';

/**
 * La solapa «Para revisar» de la bandeja (§5.8): lo que el sistema **ya
 * aplicó** y el arquitecto puede deshacer.
 *
 * Es la contracara de «Preguntas». Ahí está lo que espera algo de él y frena la
 * aprobación; acá está lo que entró solo al cómputo —una deducción con fuentes
 * por encima del umbral, una medida sacada del dibujo— con de dónde salió, con
 * qué método y con un botón «Rechazar» que lo revierte y devuelve el hueco a la
 * bandeja. **No bloquea nada**: informa. Aprobar un rubro sigue exigiendo cero
 * consultas bloqueantes, ni una más ni una menos (RF-404).
 *
 * Tres cosas conviven acá, y en este orden:
 *
 *  1. **Lo que completó el sistema** — deducciones `validada` con
 *     `validado_por = null`. Ya están en la planilla. Se rechazan, no se
 *     validan: validarlas otra vez no significaría nada.
 *  2. **Lo que espera tu visto bueno** — deducciones `propuesta`: las que no
 *     llegaron al umbral (§5.4) y por eso **no** se aplicaron. Estas sí se
 *     validan; es la bandeja de deducciones de siempre, mudada acá.
 *  3. **Los ítems inferidos** — los que el motor computó con una medida sacada
 *     del dibujo (§5.5). No son una fila que decidir sino el resultado de una,
 *     y por eso van como lista: lo que se rechaza es la medición, arriba.
 *
 * Una tarjeta por **elemento** (el tabique T1, la ventana V2), no por deducción
 * y ni siquiera por entidad: el mismo tabique dibujado en la planta y en el
 * corte genera propuestas en las dos direcciones y sueltas parecen la misma
 * sugerencia repetida. Bajo un solo título, con el nombre de su lámina al lado,
 * se leen por lo que son.
 *
 * ## El plano al lado, no a un click de distancia
 *
 * Igual que «Preguntas»: la lista comparte la pantalla con un `PanelVisor` a la
 * derecha (apilado en pantallas chicas) y elegir una lámina citada la carga ahí,
 * con los bbox de la deducción resaltados y sin navegar. Los `?highlight=` no se
 * van: el contrato de `src/app/CLAUDE.md` §4 sigue intacto y cada fila ofrece
 * «Abrir en página completa».
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
  /** 0–1. */
  confianza: number;
  laminas: LaminaCitada[];
  /** Los bbox que la sostienen, para resaltarlos en el panel de al lado. */
  fuentes: FuenteDeduccion[];
  /**
   * `true` si la validó el sistema (§5.4): ya está aplicada en el cómputo y lo
   * único que ofrece es deshacerla.
   */
  autovalidada?: boolean;
  /** Cómo se llegó al número, cuando la regla no alcanza para explicarlo. */
  metodo?: string | null;
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

/** Un ítem que el motor computó con una medida sacada del dibujo (§5.5). */
export interface ItemInferidoVista {
  id: string;
  claveItem: string;
  descripcion: string;
  /** "12,40 m²" — cantidad y unidad, ya escritas para leer. */
  cantidad: string;
  laminas: LaminaCitada[];
  /** "Medición gráfica sobre el dibujo a escala 1:50", si se pudo reconstruir. */
  metodo: string | null;
}

// ---------------------------------------------------------------------------

/** Verde ≥ 0,90, ámbar ≥ 0,80, gris el resto. */
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
 * un `useEffect(…, [destacados])` y volvería a scrollear en cada uno.
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
 * Validar o rechazar revalida la pantalla y la fila desaparece de la lista:
 * dejar el plano abierto con «A-01 · PLANTA REFORMA · alto = 1,00 m» de una
 * deducción que ya se decidió es mostrar una decisión que ya se tomó. Es el
 * mismo guard de "no fantasmas" que la bandeja (`miradaVigente`), y por el mismo
 * motivo se filtra **en el render** y no se limpia el estado: volver al filtro
 * de regla donde la deducción vive la vuelve a mostrar.
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
  const [confirmando, setConfirmando] = useState<'validar' | 'rechazar' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();
  const aplicada = deduccion.autovalidada === true;

  function correr(accion: () => Promise<{ ok: true } | { ok: false; error: string }>): void {
    setError(null);
    setConfirmando(null);
    iniciar(async () => {
      const resultado = await accion();
      if (!resultado.ok) setError(resultado.error);
    });
  }

  return (
    <li
      className={[
        'flex flex-col gap-2 border-t border-neutral-200 py-3 first:border-t-0 first:pt-0',
        // La que se está mirando en el panel, marcada: con varias filas abiertas
        // hay que saber de cuál es el bbox rojo de la derecha.
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
        {aplicada ? (
          <Badge tone="neutral" title="Ya está aplicada en el cómputo: la validó el sistema">
            En el cómputo
          </Badge>
        ) : null}
      </div>

      <p className="text-sm text-neutral-700">{deduccion.explicacion}</p>

      {/* El método, cuando el número no salió de leer nada sino de medir el
          dibujo: es lo que hace la diferencia entre revisarlo y confiar. */}
      {deduccion.metodo ? (
        <p className="text-xs text-neutral-500">Método: {deduccion.metodo}</p>
      ) : null}

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
        {/* Una deducción que el sistema ya aplicó no se valida: validarla otra
            vez no significaría nada. Lo único que ofrece es deshacerla. */}
        {aplicada ? null : confirmando === 'validar' ? (
          <span className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-neutral-600">
              Se escribe {deduccion.etiqueta} = {deduccion.valor} en el elemento. ¿Va?
            </span>
            <Button
              size="sm"
              onClick={() =>
                correr(() => validarDeduccionAction({ obraId, deduccionId: deduccion.id }))
              }
              disabled={pendiente}
            >
              Sí, validar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmando(null)}
              disabled={pendiente}
            >
              No
            </Button>
          </span>
        ) : (
          <Button size="sm" onClick={() => setConfirmando('validar')} disabled={pendiente}>
            Validar
          </Button>
        )}

        {/* Rechazar lo que ya está computado cambia números: se confirma. Sobre
            una propuesta no cambia nada y va directo, como siempre. */}
        {aplicada && confirmando === 'rechazar' ? (
          <span className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-neutral-600">
              Se saca {deduccion.etiqueta} = {deduccion.valor} del cómputo y el dato vuelve a
              faltar. ¿Va?
            </span>
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                correr(() => rechazarDeduccionAction({ obraId, deduccionId: deduccion.id }))
              }
              disabled={pendiente}
            >
              Sí, rechazar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmando(null)}
              disabled={pendiente}
            >
              No
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant={aplicada ? 'danger' : 'secondary'}
            onClick={() =>
              aplicada
                ? setConfirmando('rechazar')
                : correr(() => rechazarDeduccionAction({ obraId, deduccionId: deduccion.id }))
            }
            disabled={pendiente}
          >
            Rechazar
          </Button>
        )}
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------

interface SeccionProps {
  obraId: string;
  titulo: string;
  descripcion: string;
  grupos: readonly GrupoElemento[];
  enPanel: Seleccion | null;
  onVer: (deduccion: DeduccionVista, lamina: LaminaCitada) => void;
}

function Seccion({ obraId, titulo, descripcion, grupos, enPanel, onVer }: SeccionProps) {
  if (grupos.length === 0) return null;
  const total = grupos.reduce(
    (suma, grupo) =>
      suma + grupo.vistas.reduce((parcial, vista) => parcial + vista.deducciones.length, 0),
    0,
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold text-neutral-900">
          {titulo}
          <span className="ml-2 text-xs font-normal text-neutral-500 tabular-nums">{total}</span>
        </h2>
        <p className="text-xs text-neutral-600">{descripcion}</p>
      </div>

      {grupos.map((grupo) => (
        <Card key={grupo.clave}>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-semibold text-neutral-900">{grupo.titulo}</h3>
              <span className="text-xs text-neutral-500 tabular-nums">
                {grupo.vistas.reduce((suma, vista) => suma + vista.deducciones.length, 0)} datos
              </span>
            </div>

            {/* La simetría explicada donde aparece, no en un manual: dos láminas
                del mismo elemento completándose no son duplicación. */}
            {grupo.vistas.length > 1 ? (
              <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
                Este elemento está dibujado en {grupo.vistas.length} láminas y cada una completa lo
                que la otra no dice. No es el mismo dato repetido.
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
                      onVer={onVer}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------

export interface ParaRevisarProps {
  obraId: string;
  /** Las que el sistema validó solo y ya están en la planilla. */
  autovalidadas: GrupoElemento[];
  /** Las que no llegaron al umbral y esperan una decisión. */
  propuestas: GrupoElemento[];
  /** Los ítems computados con una medida sacada del dibujo. */
  inferidos: ItemInferidoVista[];
  /** `true` si el filtro por regla está activo: cambia el texto del vacío. */
  filtrada: boolean;
}

export function ParaRevisar({
  obraId,
  autovalidadas,
  propuestas,
  inferidos,
  filtrada,
}: ParaRevisarProps) {
  const [seleccion, setSeleccion] = useState<Seleccion | null>(null);

  // La deducción que el panel muestra tiene que seguir estando en la lista
  // (`seleccionVigente`, pinneada en `tests/unit/deducciones-plano.test.ts`).
  const enPanel = seleccionVigente(seleccion, [...autovalidadas, ...propuestas]);

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

  if (autovalidadas.length === 0 && propuestas.length === 0 && inferidos.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-neutral-900">
          {filtrada ? 'Nada de esa regla para revisar.' : 'No hay nada para revisar.'}
        </p>
        <p className="mt-1 text-sm text-neutral-600">
          {filtrada
            ? 'Probá con otra regla o mirá todas.'
            : 'Acá aparece lo que el sistema completó solo: un dato que dos láminas dicen entre las dos, o una medida sacada del dibujo. Se puede rechazar, y no frena nada.'}
        </p>
      </div>
    );
  }

  return (
    // Dos columnas desde `lg`: la lista a la izquierda y el plano a la derecha,
    // pegado al scroll. Apilado en pantallas chicas, con el panel plegable para
    // que no empuje la lista fuera de la vista.
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <div className="flex min-w-0 flex-col gap-6">
        <Seccion
          obraId={obraId}
          titulo="Lo que completó el sistema"
          descripcion="Ya están en la planilla, con su fuente y su confianza. Rechazar saca el dato del cómputo y devuelve la consulta a «Preguntas»."
          grupos={autovalidadas}
          enPanel={enPanel}
          onVer={ver}
        />

        <Seccion
          obraId={obraId}
          titulo="Esperan tu visto bueno"
          descripcion="No llegaron a la confianza necesaria para entrar solas: el cómputo todavía no las usa. Validar escribe el dato en el elemento."
          grupos={propuestas}
          enPanel={enPanel}
          onVer={ver}
        />

        {inferidos.length > 0 ? (
          <section className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-neutral-900">
                Ítems computados con medidas del dibujo
                <span className="ml-2 text-xs font-normal text-neutral-500 tabular-nums">
                  {inferidos.length}
                </span>
              </h2>
              <p className="text-xs text-neutral-600">
                Ninguna lámina acota estas medidas: se midieron sobre el dibujo a escala, que es lo
                más débil que el sistema usa. Están marcados <strong>inferido</strong> en la
                planilla. Para deshacerlo, rechazá la medición de arriba.
              </p>
            </div>
            <Card>
              <CardContent className="flex flex-col gap-3">
                {inferidos.map((item) => (
                  <div key={item.id} className="flex flex-col gap-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-neutral-900">
                      <span className="font-medium">{item.descripcion}</span>
                      <span className="tabular-nums text-neutral-600">{item.cantidad}</span>
                      <Badge tone="warn">Inferido</Badge>
                    </p>
                    {item.metodo ? (
                      <p className="text-xs text-neutral-500">Método: {item.metodo}</p>
                    ) : null}
                    {item.laminas.length > 0 ? (
                      <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                        <span>En:</span>
                        {item.laminas.map((lamina) => (
                          <Link
                            key={lamina.laminaId}
                            href={`/obras/${obraId}/laminas/${lamina.laminaId}?highlight=${item.id}`}
                            className="underline hover:text-neutral-900"
                          >
                            {lamina.etiqueta}
                          </Link>
                        ))}
                      </p>
                    ) : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        ) : null}
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
