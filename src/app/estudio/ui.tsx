'use client';

/**
 * Piezas interactivas de las pantallas del estudio.
 *
 * Todo lo que hay acá es cliente porque tiene estado de formulario
 * (`useActionState`) o de transición; los datos los trae siempre el server y
 * bajan por props. Ninguna de estas piezas decide permisos: cuando esconden un
 * botón es para no ofrecer lo que el server va a rechazar, y el server lo
 * rechaza igual (`src/lib/plataforma/roles.ts`).
 */
import Link from 'next/link';
import {
  useActionState,
  useState,
  useTransition,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ETIQUETA_ROL } from '@/lib/plataforma/roles';
import type { ItemChecklistEfectivo } from '@/lib/plataforma/checklists';
import type { UsuarioListado } from '@/lib/plataforma/usuarios';
import {
  abrirNotificacionAction,
  cambiarActivoAction,
  cambiarRolAction,
  crearInvitacionAction,
  guardarChecklistAction,
  guardarConfigAction,
  marcarTodasLeidasAction,
  type EstadoEstudio,
} from '@/app/estudio/actions';
import {
  PALANCAS,
  ROLES_USUARIO,
  RUBROS,
  type ConfigEstudio,
  type RolUsuario,
  type RubroId,
} from '@/types/domain';

const ESTADO_INICIAL: EstadoEstudio = {};

/** Número en es-AR para un `<input>`: coma decimal, sin separador de miles. */
function paraInput(valor: number | null | undefined): string {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace('.', ',');
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------

export function Aviso({ tono, children }: { tono: 'ok' | 'error'; children: ReactNode }) {
  const estilo =
    tono === 'ok'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : 'border-red-200 bg-red-50 text-red-800';
  return (
    <p role="alert" className={`rounded-md border px-3 py-2 text-sm ${estilo}`}>
      {children}
    </p>
  );
}

/** Pantalla completa de "esto no es para vos", con el rol que hace falta. */
export function SinPermiso({ que, minimo }: { que: string; minimo: 'colaborador' | 'titular' }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No tenés permiso para ver esto</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-neutral-700">
        <p>
          {minimo === 'titular'
            ? `Solo el titular del estudio puede ${que}.`
            : `Necesitás rol de colaborador o titular para ${que}.`}
        </p>
        <p>
          Si creés que es un error, pedile a un titular que te cambie el rol desde la pantalla de
          usuarios.
        </p>
        <div>
          <Link href="/obras" className="font-medium text-neutral-900 underline">
            Volver a las obras
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Campanita del header
// ---------------------------------------------------------------------------

export interface NotificacionEnCampana {
  id: string;
  titulo: string;
  cuerpo: string;
  link: string | null;
  leida: boolean;
  at: string;
}

/**
 * Campanita con el contador de no leídas y las últimas diez.
 *
 * Es un `<details>` y no un dropdown con estado: así el menú abre y cierra sin
 * JavaScript, con teclado, y el header no se vuelve un árbol de client
 * components por un menú.
 *
 * Cada aviso es un `<form>`, no un link: el click tiene que **marcar leída**
 * antes de navegar, y un `<a>` con un `fetch()` al lado pierde la carrera
 * contra la navegación.
 */
export function Campanita({
  noLeidas,
  items,
}: {
  noLeidas: number;
  items: NotificacionEnCampana[];
}) {
  const [, iniciar] = useTransition();

  return (
    <details className="relative">
      <summary
        className="flex h-8 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-neutral-700 hover:bg-neutral-100"
        aria-label={noLeidas === 0 ? 'Notificaciones' : `Notificaciones: ${noLeidas} sin leer`}
      >
        <span aria-hidden>🔔</span>
        {noLeidas > 0 ? (
          <Badge tone="error" className="tabular-nums">
            {noLeidas > 99 ? '99+' : noLeidas}
          </Badge>
        ) : null}
      </summary>

      <div className="absolute right-0 z-20 mt-2 w-80 rounded-md border border-neutral-200 bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
          <span className="text-sm font-medium text-neutral-900">Notificaciones</span>
          {noLeidas > 0 ? (
            <button
              type="button"
              className="text-xs text-neutral-600 underline hover:text-neutral-900"
              onClick={() => iniciar(() => void marcarTodasLeidasAction())}
            >
              Marcar todas
            </button>
          ) : null}
        </div>

        {items.length === 0 ? (
          <p className="px-3 py-4 text-sm text-neutral-600">No tenés avisos todavía.</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="border-b border-neutral-100 last:border-b-0">
                <form action={abrirNotificacionAction}>
                  <input type="hidden" name="notificacionId" value={item.id} />
                  <input type="hidden" name="link" value={item.link ?? ''} />
                  <button
                    type="submit"
                    className={`block w-full px-3 py-2 text-left hover:bg-neutral-50 ${
                      item.leida ? '' : 'bg-sky-50/60'
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-neutral-900">{item.titulo}</span>
                      <span className="shrink-0 text-xs text-neutral-500">{item.at}</span>
                    </span>
                    <span className="mt-0.5 block text-sm text-neutral-600">{item.cuerpo}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-neutral-200 px-3 py-2">
          <Link href="/estudio" className="text-sm text-neutral-900 underline">
            Ver todas
          </Link>
        </div>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Usuarios e invitaciones
// ---------------------------------------------------------------------------

export function FormularioInvitacion() {
  const [estado, action, pendiente] = useActionState(crearInvitacionAction, ESTADO_INICIAL);

  return (
    <div className="flex flex-col gap-3">
      {estado.error ? <Aviso tono="error">{estado.error}</Aviso> : null}
      {estado.mensaje ? <Aviso tono="ok">{estado.mensaje}</Aviso> : null}

      <form action={action} className="flex items-end gap-3">
        <div className="w-48">
          <Select label="Rol de la invitación" name="rol" defaultValue="colaborador">
            {ROLES_USUARIO.map((rol) => (
              <option key={rol} value={rol}>
                {ETIQUETA_ROL[rol]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pendiente}>
          {pendiente ? 'Generando…' : 'Generar código'}
        </Button>
      </form>

      <p className="text-sm text-neutral-600">
        Pasale el código a la persona: se registra en <code>/register</code> con ese código y entra
        directo a tu estudio. Vence a los 7 días y se usa una sola vez.
      </p>
    </div>
  );
}

/**
 * Rol y baja de un usuario.
 *
 * El titular puede bajarse a sí mismo o darse de baja **si no es el último
 * titular activo**; el core lo rechaza y acá se muestra el motivo. No se
 * esconde el botón: esconderlo dejaría al usuario sin entender por qué no
 * puede, que es justo lo que hay que explicarle.
 */
export function AccionesUsuario({ usuario, esYo }: { usuario: UsuarioListado; esYo: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  function correr(promesa: () => Promise<{ ok: boolean; error?: string }>): void {
    setError(null);
    iniciar(async () => {
      const resultado = await promesa();
      if (!resultado.ok) setError(resultado.error ?? 'No pude hacer el cambio.');
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Select
          aria-label={`Rol de ${usuario.nombre}`}
          className="w-40"
          value={usuario.rol}
          disabled={pendiente}
          onChange={(evento) =>
            correr(() =>
              cambiarRolAction({ usuarioId: usuario.id, rol: evento.target.value as RolUsuario }),
            )
          }
        >
          {ROLES_USUARIO.map((rol) => (
            <option key={rol} value={rol}>
              {ETIQUETA_ROL[rol]}
            </option>
          ))}
        </Select>

        <Button
          type="button"
          size="sm"
          variant={usuario.activo ? 'secondary' : 'primary'}
          disabled={pendiente}
          onClick={() =>
            correr(() => cambiarActivoAction({ usuarioId: usuario.id, activo: !usuario.activo }))
          }
        >
          {usuario.activo ? 'Desactivar' : 'Reactivar'}
        </Button>
      </div>

      {esYo ? <span className="text-xs text-neutral-500">Sos vos</span> : null}
      {error ? <span className="max-w-xs text-right text-xs text-red-700">{error}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

/**
 * Un bloque del formulario de configuración.
 *
 * Cada sección guarda por su cuenta —su propio `<form>`, su propio
 * `useActionState`, su propio `__seccion`— porque el core mergea por sección:
 * guardar los pesos del ranking no puede pisar los desperdicios, y una sola
 * pantalla con un solo botón "Guardar" haría exactamente eso si un campo
 * quedara vacío.
 */
function SeccionConfig({
  titulo,
  seccion,
  children,
}: {
  titulo: string;
  seccion: string;
  children: ReactNode;
}) {
  const [estado, action, pendiente] = useActionState(guardarConfigAction, ESTADO_INICIAL);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{titulo}</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="__seccion" value={seccion} />
          {estado.error ? <Aviso tono="error">{estado.error}</Aviso> : null}
          {estado.mensaje ? <Aviso tono="ok">{estado.mensaje}</Aviso> : null}
          {children}
          <div>
            <Button type="submit" disabled={pendiente}>
              {pendiente ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Textarea con etiqueta, al tono de `Input`.
 *
 * Vive acá y no en `src/components/ui/` porque es el único de la pantalla: si
 * aparece un segundo uso, se sube a primitiva.
 */
function AreaTexto({
  label,
  ...props
}: { label: string } & ComponentPropsWithRef<'textarea'>) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-700">{label}</span>
      <textarea
        rows={4}
        className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-neutral-900"
        {...props}
      />
    </label>
  );
}

const NOMBRE_RUBRO: Record<RubroId, string> = {
  aberturas: 'Aberturas',
  seco: 'Construcción en seco',
  pintura: 'Pintura',
  gruesa: 'Obra gruesa',
  terminaciones: 'Terminaciones',
  sanitaria: 'Instalación sanitaria',
  electrica: 'Instalación eléctrica',
  demolicion: 'Demolición',
};

const FRASE_PALANCA: Record<(typeof PALANCAS)[number], string> = {
  volumen: 'Volumen del pedido',
  plazo_pago: 'Plazo de pago',
  fecha: 'Fecha de entrega',
  adjudicacion_inmediata: 'Adjudicación inmediata',
};

export function FormulariosConfig({
  config,
  desperdiciosDePlantilla,
}: {
  config: ConfigEstudio;
  desperdiciosDePlantilla: Record<RubroId, number>;
}) {
  // El `<details>` de las instrucciones por rubro arranca cerrado: el contador
  // es lo que avisa que adentro hay algo escrito.
  const rubrosConInstruccion = RUBROS.filter(
    (rubro) => (config.instruccionesExtraccion.porRubro[rubro] ?? '').trim() !== '',
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <SeccionConfig titulo="Instrucciones de extracción" seccion="instrucciones">
        <p className="text-sm text-neutral-600">
          Lo que le explicarías a alguien que abre tus planos por primera vez, escrito una sola vez:
          viaja con <strong className="font-medium">cada lámina que se analiza</strong>, en todas las
          obras del estudio. Sirve para decir dónde mirar y cómo leerlo — no para pedir que complete
          lo que la lámina no dice: eso sigue siendo una consulta en la bandeja.
        </p>
        <AreaTexto
          label="Para todas las láminas"
          name="instruccion.general"
          rows={4}
          defaultValue={config.instruccionesExtraccion.general}
          placeholder={
            'Ejemplo: las cotas de nuestros planos están en centímetros. Las medidas de las carpinterías nunca están en la planta: están en la planilla de la lámina DET00.'
          }
        />

        <details className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
          <summary className="cursor-pointer list-none text-sm font-medium text-neutral-800">
            Instrucciones por rubro ({rubrosConInstruccion} de {RUBROS.length} con texto)
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            <p className="text-sm text-neutral-600">
              Se suman a las de arriba en cada lámina, etiquetadas con el rubro
              («Aberturas: …»), para que el análisis sepa a cuál aplica cada una. El estilo es el
              del dictado a un ayudante, paso por paso:{' '}
              <em>
                «identificá los tramos horizontales de agua caliente en planta y su longitud en
                metros; después los accesorios: codos a 90, a 45, tés…»
              </em>
            </p>
            {RUBROS.map((rubro) => (
              <AreaTexto
                key={rubro}
                label={NOMBRE_RUBRO[rubro]}
                name={`instruccion.${rubro}`}
                rows={3}
                defaultValue={config.instruccionesExtraccion.porRubro[rubro] ?? ''}
              />
            ))}
          </div>
        </details>
      </SeccionConfig>

      <SeccionConfig titulo="Desperdicio por rubro" seccion="desperdicios">
        <p className="text-sm text-neutral-600">
          Pisa el desperdicio de referencia de la plantilla del rubro. Vacío = el de la plantilla.
          Los ítems que la plantilla emite con otro desperdicio (soleras, montantes, tornillos) no
          se tocan.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {RUBROS.map((rubro) => (
            <Input
              key={rubro}
              label={`${NOMBRE_RUBRO[rubro]} (plantilla: ${desperdiciosDePlantilla[rubro]}%)`}
              name={`desperdicio.${rubro}`}
              inputMode="decimal"
              placeholder={String(desperdiciosDePlantilla[rubro])}
              defaultValue={paraInput(config.desperdiciosPct[rubro])}
            />
          ))}
        </div>
      </SeccionConfig>

      <SeccionConfig titulo="Condiciones por defecto del pedido" seccion="condiciones">
        <p className="text-sm text-neutral-600">
          El IVA va siempre discriminado (PRD §13): no es configurable.
        </p>
        <label className="flex items-center gap-2 text-sm text-neutral-800">
          <input
            type="checkbox"
            name="separarManoObraMateriales"
            defaultChecked={config.condicionesDefault.separarManoObraMateriales}
            className="size-4"
          />
          Pedir mano de obra y materiales separados
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Validez mínima de la cotización (días)"
            name="validezMinimaDias"
            inputMode="numeric"
            defaultValue={String(config.condicionesDefault.validezMinimaDias)}
          />
          <Input
            label="Plazo de entrega pedido (días, vacío = sin pedir)"
            name="plazoEntregaDias"
            inputMode="numeric"
            defaultValue={paraInput(config.condicionesDefault.plazoEntregaDias)}
          />
        </div>
        <Input
          label="Notas que se agregan a todos los pedidos"
          name="notas"
          defaultValue={config.condicionesDefault.notas ?? ''}
        />
      </SeccionConfig>

      <SeccionConfig titulo="Mandato de negociación por defecto" seccion="mandato">
        <p className="text-sm text-neutral-600">
          Dos rondas como máximo (RF-1001, fijo). El objetivo de mejora tiene que ser menor a 100%.
        </p>
        <Input
          label="Objetivo de mejora (%)"
          name="objetivoMejoraPct"
          inputMode="decimal"
          defaultValue={paraInput(config.mandatoDefault.objetivoMejoraPct)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-neutral-700">
            Palancas que el agente puede usar
          </legend>
          {PALANCAS.map((palanca) => (
            <label key={palanca} className="flex items-center gap-2 text-sm text-neutral-800">
              <input
                type="checkbox"
                name="palancas"
                value={palanca}
                defaultChecked={config.mandatoDefault.palancas.includes(palanca)}
                className="size-4"
              />
              {FRASE_PALANCA[palanca]}
            </label>
          ))}
        </fieldset>
      </SeccionConfig>

      <SeccionConfig titulo="Pesos del ranking de comparativa" seccion="pesos">
        <p className="text-sm text-neutral-600">
          Tienen que sumar 1 (RF-1101). Por defecto: 0,5 precio + 0,3 fidelidad + 0,2 plazo.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            label="Precio total"
            name="peso.total"
            inputMode="decimal"
            defaultValue={paraInput(config.pesosRanking.total)}
          />
          <Input
            label="Fidelidad al pedido"
            name="peso.fidelidad"
            inputMode="decimal"
            defaultValue={paraInput(config.pesosRanking.fidelidad)}
          />
          <Input
            label="Plazo"
            name="peso.plazo"
            inputMode="decimal"
            defaultValue={paraInput(config.pesosRanking.plazo)}
          />
        </div>
      </SeccionConfig>

      <SeccionConfig titulo="Dólar MEP de referencia" seccion="mep">
        <p className="text-sm text-neutral-600">
          Se carga a mano: el sistema no consulta cotizaciones. Vacío = el estudio no cotiza en
          dólares.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Valor"
            name="mepValor"
            inputMode="decimal"
            defaultValue={paraInput(config.mepReferencia?.valor ?? null)}
          />
          <Input
            label="Fecha (2026-08-26)"
            name="mepFecha"
            type="date"
            defaultValue={config.mepReferencia?.fecha ?? ''}
          />
        </div>
      </SeccionConfig>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export function FilaChecklist({ rubro, item }: { rubro: RubroId; item: ItemChecklistEfectivo }) {
  const [error, setError] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  function guardar(cambios: { activo?: boolean; bloqueante?: boolean }): void {
    setError(null);
    iniciar(async () => {
      const resultado = await guardarChecklistAction({ rubro, itemId: item.itemId, ...cambios });
      if (!resultado.ok) setError(resultado.error);
    });
  }

  return (
    <li className="flex flex-col gap-1 border-b border-neutral-100 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-neutral-900">{item.descripcion}</p>
          <p className="mt-0.5 font-mono text-xs text-neutral-500">{item.itemId}</p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              className="size-4"
              checked={item.activo}
              disabled={pendiente}
              onChange={(evento) => guardar({ activo: evento.target.checked })}
            />
            Se chequea
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              className="size-4"
              checked={item.bloqueante}
              disabled={pendiente || !item.activo}
              onChange={(evento) => guardar({ bloqueante: evento.target.checked })}
            />
            Frena la aprobación
          </label>
        </div>
      </div>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </li>
  );
}
