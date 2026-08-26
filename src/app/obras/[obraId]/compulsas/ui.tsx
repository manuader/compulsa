'use client';

/**
 * Las piezas interactivas de las pantallas de compulsa.
 *
 * El resto es Server Component (`src/app/CLAUDE.md` §2): las páginas leen con
 * `getDb()`, arman los textos y los estados, y bajan acá **solo datos
 * serializables**. Nada de esto vuelve a consultar la base.
 *
 * Dos islas:
 *
 *  1. `FormularioNuevaCompulsa` — el wizard de armado, en una sola página.
 *  2. `PanelContacto` — el timeline de un proveedor con todo lo que se puede
 *     hacer sobre él: marcar enviado, registrar la respuesta con preview,
 *     proponer la negociación, **cerrar la ronda con lo que contestó**, cargar
 *     el total que faltaba y descartar una cotización que quedó vieja.
 *
 * El botón de copiar —que en un canal manual es la acción principal de estas
 * pantallas— es una primitiva compartida: `@/components/ui/boton-copiar`.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  cargarTotalCotizacionAction,
  confirmarCotizacionAction,
  descartarCotizacionAction,
  lanzarCompulsaAction,
  previsualizarRespuestaAction,
  proponerNegociacionAction,
  registrarEnvioAction,
  resolverNegociacionAction,
  type PreviewPresupuesto,
} from '@/app/obras/[obraId]/compulsas/actions';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { BotonCopiar } from '@/components/ui/boton-copiar';
import { Button, estilosBoton } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { formatearNumero } from '@/lib/computo/unidades';
import type { CondicionesRfq, EstadoContacto, Mandato, MatchConciliacion } from '@/types/domain';

// ---------------------------------------------------------------------------
// Datos que bajan del server (todo serializable)
// ---------------------------------------------------------------------------

export interface ProveedorOfrecido {
  id: string;
  nombre: string;
  /** "Red con historial", "De la zona"… ya traducido por la página. */
  grupo: string;
  grupoTono: BadgeTone;
  zona: string;
  cotizaciones: number;
  /** Canales cargados en la agenda, ya formateados. */
  contacto: string | null;
}

export interface ProveedorExcluidoVista {
  proveedorId: string;
  nombre: string;
  motivo: string;
}

export interface ItemPrevistoVista {
  claveItem: string;
  descripcion: string;
  cantidad: string;
  presentacion: string;
}

export interface AdjuntoVista {
  ref: string;
  nombre: string;
}

export interface MensajeVista {
  id: string;
  direccion: 'saliente' | 'entrante';
  estado: 'pendiente_envio_manual' | 'enviado' | 'recibido';
  texto: string;
  adjuntos: AdjuntoVista[];
  /** Fecha ya formateada en es-AR por el server. */
  fecha: string;
  /** El próximo borrador que `registrarEnvio` va a firmar (el más viejo). */
  esProximoEnvio: boolean;
}

/** La ronda que se mandó y todavía no tiene resultado (RF-1003). */
export interface NegociacionPendienteVista {
  id: string;
  ronda: number;
  /** El número que se le pidió, ya formateado en es-AR. */
  objetivoTotal: string | null;
}

export interface CotizacionVista {
  id: string;
  fecha: string;
  total: string | null;
  moneda: string;
  tieneTotal: boolean;
  score: string | null;
  incluyeIva: boolean;
  validezDias: number | null;
  plazoDias: number | null;
  formaPago: string | null;
  lineas: number;
  sustituciones: number;
  /** Fuera de la comparativa, del ranking y del ahorro (`estado = 'descartada'`). */
  descartada: boolean;
  negociacionPendiente: NegociacionPendienteVista | null;
}

export interface BanderaVista {
  cotizacionId: string;
  claveItem: string;
  nota: string;
}

export interface ContactoVista {
  id: string;
  proveedor: string;
  estado: EstadoContacto;
  estadoEtiqueta: string;
  mensajes: MensajeVista[];
  pendientes: number;
  cotizaciones: CotizacionVista[];
  banderas: BanderaVista[];
  /** Días de silencio, si pasaron 7 o más. */
  sinRespuestaDias: number | null;
  /**
   * Por qué este contacto ya no admite escrituras sobre sus cotizaciones, o
   * `null` si sigue en juego.
   *
   * Con la compulsa adjudicada (o el contacto cerrado), cerrar una ronda o
   * descartar una cotización movería el ahorro y la comparativa que quedaron
   * firmados con la orden de compra. El núcleo lo rechaza igual
   * (`exigirCompulsaEnJuego`); esconder los botones es para no ofrecer una
   * acción que va a fallar.
   */
  motivoBloqueo: string | null;
}

// ---------------------------------------------------------------------------
// Wizard de armado
// ---------------------------------------------------------------------------

const PALANCAS: { valor: Mandato['palancas'][number]; etiqueta: string }[] = [
  { valor: 'volumen', etiqueta: 'Volumen (todo el rubro en una compra)' },
  { valor: 'plazo_pago', etiqueta: 'Plazo de pago (pago contra entrega)' },
  { valor: 'fecha', etiqueta: 'Fecha de entrega flexible' },
  { valor: 'adjudicacion_inmediata', etiqueta: 'Adjudicación inmediata' },
];

export interface FormularioNuevaCompulsaProps {
  obraId: string;
  rubro: string;
  rubroNombre: string;
  items: ItemPrevistoVista[];
  condiciones: CondicionesRfq;
  mandato: Mandato | null;
  proveedores: ProveedorOfrecido[];
  excluidos: ProveedorExcluidoVista[];
  /** Lanzar es del titular (RF-1201). Si no lo es, el formulario lo dice. */
  puedeLanzar: boolean;
  motivoSinPermiso: string | null;
}

export function FormularioNuevaCompulsa({
  obraId,
  rubro,
  rubroNombre,
  items,
  condiciones,
  mandato,
  proveedores,
  excluidos,
  puedeLanzar,
  motivoSinPermiso,
}: FormularioNuevaCompulsaProps) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);

  const [separar, setSeparar] = useState(condiciones.separarManoObraMateriales);
  const [validez, setValidez] = useState(String(condiciones.validezMinimaDias));
  const [plazo, setPlazo] = useState(
    condiciones.plazoEntregaDias === null ? '' : String(condiciones.plazoEntregaDias),
  );
  const [notas, setNotas] = useState(condiciones.notas ?? '');

  const [negocia, setNegocia] = useState(mandato !== null);
  const [objetivo, setObjetivo] = useState(String(mandato?.objetivoMejoraPct ?? 5));
  const [palancas, setPalancas] = useState<string[]>([...(mandato?.palancas ?? [])]);

  const [elegidos, setElegidos] = useState<string[]>(
    proveedores.slice(0, 3).map((proveedor) => proveedor.id),
  );

  function alternar(lista: string[], valor: string): string[] {
    return lista.includes(valor) ? lista.filter((v) => v !== valor) : [...lista, valor];
  }

  function armarPayload() {
    const plazoNumero = plazo.trim() === '' ? null : Number(plazo);
    return {
      obraId,
      rubro,
      condiciones: {
        ivaDiscriminado: true as const,
        separarManoObraMateriales: separar,
        validezMinimaDias: Number(validez),
        plazoEntregaDias: Number.isFinite(plazoNumero) ? plazoNumero : null,
        notas: notas.trim() === '' ? null : notas.trim(),
      },
      mandato: negocia
        ? {
            objetivoMejoraPct: Number(objetivo),
            palancas: palancas as Mandato['palancas'],
            maxRondas: 2 as const,
          }
        : null,
      proveedorIds: elegidos,
    };
  }

  function lanzar(): void {
    setError(null);
    setConfirmando(false);
    iniciar(async () => {
      const resultado = await lanzarCompulsaAction(armarPayload());
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      router.push(`/obras/${obraId}/compulsas/${resultado.compulsaId}`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* --- 2. Condiciones ------------------------------------------------ */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-900">
            2 · Condiciones del pedido
          </h2>
          <p className="text-xs text-neutral-600">
            Salen de la configuración del estudio y se pueden pisar para esta compulsa. El IVA
            discriminado no es opcional (PRD §13).
          </p>

          <label className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={separar}
              onChange={() => setSeparar((valor) => !valor)}
              className="size-4"
            />
            Pedir mano de obra, materiales y flete por separado
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Validez mínima de la oferta (días)"
              type="number"
              min={1}
              value={validez}
              onChange={(evento) => setValidez(evento.target.value)}
            />
            <Input
              label="Plazo de entrega (días, vacío = sin exigir)"
              type="number"
              min={0}
              value={plazo}
              onChange={(evento) => setPlazo(evento.target.value)}
            />
          </div>

          <Input
            label="Notas para el proveedor"
            value={notas}
            placeholder="Entrega en obra, con descarga"
            onChange={(evento) => setNotas(evento.target.value)}
          />
        </CardContent>
      </Card>

      {/* --- 3. Mandato ---------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-900">3 · Mandato de negociación</h2>

          <label className="flex items-center gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={negocia}
              onChange={() => setNegocia((valor) => !valor)}
              className="size-4"
            />
            Habilitar contraofertas (máximo 2 rondas, RF-1001)
          </label>

          {negocia ? (
            <>
              <Input
                label="Objetivo de mejora (%)"
                type="number"
                min={0}
                max={99}
                value={objetivo}
                onChange={(evento) => setObjetivo(evento.target.value)}
              />
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium text-neutral-700">
                  Palancas que puede usar el mensaje
                </legend>
                {PALANCAS.map((palanca) => (
                  <label key={palanca.valor} className="flex items-center gap-2 text-sm text-neutral-800">
                    <input
                      type="checkbox"
                      checked={palancas.includes(palanca.valor)}
                      onChange={() => setPalancas((lista) => alternar(lista, palanca.valor))}
                      className="size-4"
                    />
                    {palanca.etiqueta}
                  </label>
                ))}
              </fieldset>
            </>
          ) : (
            <p className="text-xs text-neutral-600">
              Sin mandato, la compulsa se lanza igual y el motor no propone contraofertas.
            </p>
          )}
        </CardContent>
      </Card>

      {/* --- 4. Proveedores ------------------------------------------------ */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-900">4 · A quién le pedimos precio</h2>

          {proveedores.length === 0 ? (
            <p className="text-sm text-neutral-700">
              No hay proveedores de {rubroNombre.toLowerCase()} en la agenda.{' '}
              <Link href="/proveedores/nuevo" className="font-medium text-neutral-900 underline">
                Cargá uno
              </Link>{' '}
              antes de lanzar.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-200">
              {proveedores.map((proveedor) => (
                <li key={proveedor.id} className="py-2">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={elegidos.includes(proveedor.id)}
                      onChange={() => setElegidos((lista) => alternar(lista, proveedor.id))}
                      className="mt-1 size-4"
                    />
                    <span className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-neutral-900">
                          {proveedor.nombre}
                        </span>
                        <Badge tone={proveedor.grupoTono}>{proveedor.grupo}</Badge>
                        {proveedor.cotizaciones > 0 ? (
                          <span className="text-xs text-neutral-500">
                            {proveedor.cotizaciones === 1
                              ? '1 cotización previa'
                              : `${proveedor.cotizaciones} cotizaciones previas`}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-neutral-600">
                        {proveedor.zona}
                        {proveedor.contacto ? ` · ${proveedor.contacto}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {excluidos.length > 0 ? (
            <div className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2">
              <p className="text-xs font-medium text-neutral-700">
                No entran a la compulsa ({excluidos.length}):
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {excluidos.map((excluido) => (
                  <li key={excluido.proveedorId} className="text-xs text-neutral-600">
                    <strong className="font-medium text-neutral-800">{excluido.nombre}</strong> —{' '}
                    {excluido.motivo}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* --- 5. Lanzar ----------------------------------------------------- */}
      {error ? (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {!puedeLanzar ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {motivoSinPermiso ?? 'Lanzar una compulsa es del titular del estudio.'}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => setConfirmando(true)}
          disabled={!puedeLanzar || pendiente || elegidos.length === 0}
        >
          Lanzar la compulsa
        </Button>
        <Link href={`/obras/${obraId}/compulsas`} className={estilosBoton('ghost')}>
          Cancelar
        </Link>
        {elegidos.length === 0 ? (
          <span className="text-xs text-neutral-600">Elegí al menos un proveedor.</span>
        ) : null}
      </div>

      <Dialog
        open={confirmando}
        onClose={() => setConfirmando(false)}
        title="Revisá antes de lanzar"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmando(false)} disabled={pendiente}>
              Volver
            </Button>
            <Button onClick={lanzar} disabled={pendiente}>
              {pendiente ? 'Lanzando…' : 'Sí, lanzar'}
            </Button>
          </>
        }
      >
        <ul className="flex flex-col gap-1 text-sm text-neutral-800">
          <li>
            <strong className="font-medium">Rubro:</strong> {rubroNombre}, {items.length}{' '}
            {items.length === 1 ? 'ítem' : 'ítems'} congelados con su hash.
          </li>
          <li>
            <strong className="font-medium">Proveedores:</strong> {elegidos.length}
            {excluidos.length > 0 ? ` (${excluidos.length} quedan afuera)` : ''}.
          </li>
          <li>
            <strong className="font-medium">Condiciones:</strong> IVA discriminado
            {separar ? ', mano de obra y materiales separados' : ''}, validez {validez} días
            {plazo.trim() === '' ? '' : `, entrega en ${plazo} días`}.
          </li>
          <li>
            <strong className="font-medium">Mandato:</strong>{' '}
            {negocia
              ? `buscar ${objetivo}% de mejora con ${palancas.length} ${palancas.length === 1 ? 'palanca' : 'palancas'}`
              : 'sin negociación automática'}
            .
          </li>
        </ul>
        <p className="mt-3 text-xs text-neutral-600">
          El sistema escribe los mensajes; mandarlos lo hacés vos por donde ya hablás con cada
          proveedor.
        </p>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel de un contacto (timeline + acciones)
// ---------------------------------------------------------------------------

const PASOS: { estado: EstadoContacto; etiqueta: string }[] = [
  { estado: 'pendiente', etiqueta: 'Por mandar' },
  { estado: 'contactado', etiqueta: 'Contactado' },
  { estado: 'cotizo', etiqueta: 'Cotizó' },
  { estado: 'negociando', etiqueta: 'Negociando' },
  { estado: 'cerrado', etiqueta: 'Cerrado' },
];

function Stepper({ estado }: { estado: EstadoContacto }) {
  // `sin_respuesta` no está en la línea: no es un paso adelante, es un desvío.
  const indice = PASOS.findIndex((paso) => paso.estado === estado);

  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs">
      {PASOS.map((paso, posicion) => {
        const alcanzado = indice >= posicion && indice !== -1;
        return (
          <li key={paso.estado} className="flex items-center gap-1">
            <span
              className={[
                'inline-flex items-center rounded-full px-2 py-0.5',
                alcanzado ? 'bg-neutral-900 text-white' : 'bg-neutral-200 text-neutral-600',
              ].join(' ')}
            >
              {paso.etiqueta}
            </span>
            {posicion < PASOS.length - 1 ? (
              <span aria-hidden="true" className="text-neutral-400">
                ›
              </span>
            ) : null}
          </li>
        );
      })}
      {estado === 'sin_respuesta' ? <Badge tone="warn">Sin respuesta</Badge> : null}
    </ol>
  );
}

const TONO_MATCH: Record<MatchConciliacion, BadgeTone> = {
  exacto: 'ok',
  parcial: 'warn',
  sustituto: 'error',
  no_cotizado: 'neutral',
  extra: 'info',
};

const ETIQUETA_MATCH: Record<MatchConciliacion, string> = {
  exacto: 'Exacto',
  parcial: 'Parcial',
  sustituto: 'Sustitución',
  no_cotizado: 'No cotizado',
  extra: 'Extra',
};

function importe(valor: number | null): string {
  return valor === null ? '—' : formatearNumero(valor, 2);
}

export interface PanelContactoProps {
  obraId: string;
  contacto: ContactoVista;
  /** `colaborador` para arriba: registrar envíos y respuestas (RF-1201). */
  puedeEscribir: boolean;
}

export function PanelContacto({ obraId, contacto, puedeEscribir }: PanelContactoProps) {
  // Rol **y** compulsa en juego: después de adjudicar, tocar una cotización
  // mueve el ahorro que ya se firmó, y el núcleo lo rechaza.
  const puedeTocarCotizaciones = puedeEscribir && contacto.motivoBloqueo === null;
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [dialogo, setDialogo] = useState(false);
  const [texto, setTexto] = useState('');
  const [preview, setPreview] = useState<PreviewPresupuesto | null>(null);

  const [totalDe, setTotalDe] = useState<string | null>(null);
  const [total, setTotal] = useState('');

  // Cerrar la ronda con «Aceptó» abre el campo del precio nuevo; descartar
  // abre el del motivo. Los dos guardan el id de la cotización sobre la que
  // está trabajando el usuario: no hay dos abiertos a la vez.
  const [aceptandoDe, setAceptandoDe] = useState<string | null>(null);
  const [mejorado, setMejorado] = useState('');
  const [descartandoDe, setDescartandoDe] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');

  function correr(accion: () => Promise<{ ok: boolean; error?: string }>): void {
    setError(null);
    iniciar(async () => {
      const resultado = await accion();
      if (!resultado.ok) setError(resultado.error ?? 'No se pudo.');
      else router.refresh();
    });
  }

  function leerPresupuesto(): void {
    setError(null);
    iniciar(async () => {
      const resultado = await previsualizarRespuestaAction({
        obraId,
        contactoId: contacto.id,
        nombre: `respuesta-${contacto.proveedor}`,
        texto,
      });
      if (!resultado.ok) {
        setError(resultado.error);
        setPreview(null);
        return;
      }
      setPreview(resultado.preview);
    });
  }

  function confirmar(): void {
    if (!preview) return;
    setError(null);
    iniciar(async () => {
      const resultado = await confirmarCotizacionAction({
        obraId,
        contactoId: contacto.id,
        nombre: `respuesta-${contacto.proveedor}`,
        texto,
        lineas: preview.lineas,
        metadatos: preview.metadatos,
      });
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      setDialogo(false);
      setPreview(null);
      setTexto('');
      setAviso(
        `Cotización guardada: fidelidad ${Math.round(resultado.score * 100)}% del pedido` +
          (resultado.repreguntas > 0
            ? `, ${resultado.repreguntas} ${resultado.repreguntas === 1 ? 'repregunta lista' : 'repreguntas listas'} para mandar.`
            : '.'),
      );
      router.refresh();
    });
  }

  function negociar(cotizacionId: string): void {
    setError(null);
    setAviso(null);
    iniciar(async () => {
      const resultado = await proponerNegociacionAction({ obraId, cotizacionId });
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      if (!resultado.procede) {
        setAviso(resultado.motivo);
        return;
      }
      setAviso(
        `Ronda ${resultado.ronda}: el mensaje quedó listo para mandar, más abajo en el hilo.`,
      );
      router.refresh();
    });
  }

  return (
    <Card id={`contacto-${contacto.id}`}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-neutral-900">{contacto.proveedor}</h3>
            <Badge tone={contacto.estado === 'cerrado' ? 'neutral' : 'info'}>
              {contacto.estadoEtiqueta}
            </Badge>
            {contacto.banderas.length > 0 ? (
              <Badge tone="error">
                {contacto.banderas.length === 1
                  ? '1 sustitución de especificación'
                  : `${contacto.banderas.length} sustituciones de especificación`}
              </Badge>
            ) : null}
          </div>
          <Link
            href={`/obras/${obraId}/conversaciones/${contacto.id}`}
            className="text-xs font-medium text-neutral-900 underline"
          >
            Ver la conversación
          </Link>
        </div>

        <Stepper estado={contacto.estado} />

        {contacto.sinRespuestaDias !== null ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Sin respuesta hace {contacto.sinRespuestaDias} días. Insistí con el mensaje de abajo, o
            marcá el contacto como cerrado desde la conversación.
          </p>
        ) : null}

        {/* Cortesía, no autorización: el núcleo rechaza igual (`src/app/CLAUDE.md`
            §«El rol se pide en el núcleo»). Ofrecer un «Aceptó» que va a fallar
            —y que si funcionara movería el ahorro ya firmado— es mentirle al
            usuario dos veces. */}
        {puedeEscribir && contacto.motivoBloqueo ? (
          <p className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
            {contacto.motivoBloqueo}
          </p>
        ) : null}

        {contacto.banderas.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-md border border-red-300 bg-red-50 px-3 py-2">
            {contacto.banderas.map((bandera) => (
              <li key={`${bandera.cotizacionId}-${bandera.claveItem}`} className="text-sm text-red-800">
                <strong className="font-medium">{bandera.claveItem}</strong>: {bandera.nota}
              </li>
            ))}
          </ul>
        ) : null}

        {/* --- Cotizaciones ------------------------------------------------ */}
        {contacto.cotizaciones.map((cotizacion) => (
          <div
            key={cotizacion.id}
            id={`cotizacion-${cotizacion.id}`}
            className={[
              'flex flex-col gap-2 rounded-md border px-3 py-2',
              cotizacion.descartada
                ? 'border-neutral-200 bg-white opacity-60'
                : 'border-neutral-200 bg-neutral-50',
            ].join(' ')}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-800">
              <strong className="font-medium">Cotización del {cotizacion.fecha}</strong>
              {cotizacion.descartada ? <Badge tone="neutral">Descartada</Badge> : null}
              {cotizacion.score !== null ? (
                <Badge tone="info">Fidelidad {cotizacion.score}</Badge>
              ) : null}
              <span>
                {cotizacion.lineas} {cotizacion.lineas === 1 ? 'línea' : 'líneas'}
              </span>
              <span>
                Total:{' '}
                {cotizacion.tieneTotal
                  ? `${cotizacion.moneda} ${cotizacion.total}`
                  : 'no lo declaró'}
              </span>
              <span>{cotizacion.incluyeIva ? 'IVA incluido' : 'IVA discriminado'}</span>
              {cotizacion.validezDias !== null ? (
                <span>Validez {cotizacion.validezDias} días</span>
              ) : null}
              {cotizacion.plazoDias !== null ? <span>Entrega {cotizacion.plazoDias} días</span> : null}
            </div>

            {/* --- Cerrar la ronda que quedó esperando (RF-1003) ----------- */}
            {puedeTocarCotizaciones && cotizacion.negociacionPendiente && !cotizacion.descartada ? (
              <div className="flex flex-col gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2">
                <p className="text-sm text-sky-900">
                  Ronda {cotizacion.negociacionPendiente.ronda} mandada
                  {cotizacion.negociacionPendiente.objetivoTotal === null
                    ? ''
                    : `, pidiendo ${cotizacion.moneda} ${cotizacion.negociacionPendiente.objetivoTotal}`}
                  . ¿Qué contestó? Mientras no lo digas, la mejora no cuenta para el ahorro de la
                  compulsa.
                </p>
                {aceptandoDe === cotizacion.id ? (
                  <span className="flex flex-wrap items-end gap-2">
                    <Input
                      label={`Total nuevo (${cotizacion.moneda})`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={mejorado}
                      onChange={(evento) => setMejorado(evento.target.value)}
                      className="w-48"
                    />
                    <Button
                      size="sm"
                      disabled={pendiente}
                      onClick={() =>
                        correr(async () => {
                          const resultado = await resolverNegociacionAction({
                            obraId,
                            negociacionId: cotizacion.negociacionPendiente!.id,
                            resultado: 'aceptada',
                            nuevoTotal: Number(mejorado),
                          });
                          if (resultado.ok) {
                            setAceptandoDe(null);
                            setMejorado('');
                          }
                          return resultado;
                        })
                      }
                    >
                      Guardar el precio mejorado
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAceptandoDe(null)}
                      disabled={pendiente}
                    >
                      Cancelar
                    </Button>
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setAceptandoDe(cotizacion.id);
                        setMejorado('');
                      }}
                      disabled={pendiente}
                    >
                      Aceptó: cargar el precio nuevo
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pendiente}
                      onClick={() =>
                        correr(() =>
                          resolverNegociacionAction({
                            obraId,
                            negociacionId: cotizacion.negociacionPendiente!.id,
                            resultado: 'rechazada',
                          }),
                        )
                      }
                    >
                      No aceptó
                    </Button>
                  </span>
                )}
              </div>
            ) : null}

            {puedeTocarCotizaciones && !cotizacion.descartada ? (
              <div className="flex flex-wrap items-center gap-2">
                {cotizacion.tieneTotal ? (
                  <Button size="sm" variant="secondary" onClick={() => negociar(cotizacion.id)} disabled={pendiente}>
                    Proponer negociación
                  </Button>
                ) : totalDe === cotizacion.id ? (
                  <span className="flex flex-wrap items-end gap-2">
                    <Input
                      label={`Total declarado (${cotizacion.moneda})`}
                      type="number"
                      min={0}
                      step="0.01"
                      value={total}
                      onChange={(evento) => setTotal(evento.target.value)}
                      className="w-48"
                    />
                    <Button
                      size="sm"
                      disabled={pendiente}
                      onClick={() =>
                        correr(async () => {
                          const resultado = await cargarTotalCotizacionAction({
                            obraId,
                            cotizacionId: cotizacion.id,
                            total: Number(total),
                          });
                          if (resultado.ok) {
                            setTotalDe(null);
                            setTotal('');
                          }
                          return resultado;
                        })
                      }
                    >
                      Guardar el total
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setTotalDe(null)} disabled={pendiente}>
                      Cancelar
                    </Button>
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setTotalDe(cotizacion.id)}>
                      Cargar el total
                    </Button>
                    <span className="text-xs text-neutral-600">
                      Sin total no hay contra qué negociar: cargalo del presupuesto.
                    </span>
                  </span>
                )}

                {/* Descartar no borra: saca la columna del cuadro, del ranking
                    y de la mediana del ahorro. Es lo que hay que hacer cuando el
                    proveedor recotiza, para que su oferta vieja no compita
                    contra la nueva. */}
                {descartandoDe === cotizacion.id ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDescartandoDe(cotizacion.id);
                      setMotivo('');
                    }}
                    disabled={pendiente}
                  >
                    Descartar
                  </Button>
                )}
              </div>
            ) : null}

            {puedeTocarCotizaciones && descartandoDe === cotizacion.id ? (
              <span className="flex flex-wrap items-end gap-2">
                <Input
                  label="Por qué se descarta"
                  placeholder="Mandó un presupuesto corregido"
                  value={motivo}
                  onChange={(evento) => setMotivo(evento.target.value)}
                  className="w-72"
                />
                <Button
                  size="sm"
                  disabled={pendiente || motivo.trim() === ''}
                  onClick={() =>
                    correr(async () => {
                      const resultado = await descartarCotizacionAction({
                        obraId,
                        cotizacionId: cotizacion.id,
                        motivo,
                      });
                      if (resultado.ok) {
                        setDescartandoDe(null);
                        setMotivo('');
                      }
                      return resultado;
                    })
                  }
                >
                  Sacarla de la comparativa
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDescartandoDe(null)}
                  disabled={pendiente}
                >
                  Cancelar
                </Button>
              </span>
            ) : null}

            {cotizacion.descartada ? (
              <p className="text-xs text-neutral-600">
                Descartada: no entra a la comparativa, al ranking ni al ahorro. La cotización queda
                guardada y el motivo está en la auditoría.
              </p>
            ) : null}
          </div>
        ))}

        {/* --- Hilo -------------------------------------------------------- */}
        <ul className="flex flex-col gap-3">
          {contacto.mensajes.map((mensaje) => (
            <li
              key={mensaje.id}
              className={[
                'rounded-md border px-3 py-2',
                mensaje.direccion === 'saliente'
                  ? 'border-neutral-200 bg-white'
                  : 'border-sky-200 bg-sky-50',
              ].join(' ')}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={mensaje.direccion === 'saliente' ? 'neutral' : 'info'}>
                  {mensaje.direccion === 'saliente' ? 'Nuestro' : 'Del proveedor'}
                </Badge>
                {mensaje.estado === 'pendiente_envio_manual' ? (
                  <Badge tone="warn">Pendiente de envío</Badge>
                ) : null}
                <span className="text-xs text-neutral-500">{mensaje.fecha}</span>
              </div>

              <pre className="mt-2 max-h-64 overflow-auto text-sm whitespace-pre-wrap text-neutral-800">
                {mensaje.texto}
              </pre>

              {mensaje.adjuntos.length > 0 ? (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-neutral-500">Recortes de plano:</span>
                  {mensaje.adjuntos.map((adjunto) => (
                    // `<a>` y no `<Link>`: son descargas de la API, no navegación.
                    <a
                      key={adjunto.ref}
                      href={`/api/archivos/${adjunto.ref}`}
                      className="font-medium text-neutral-900 underline"
                    >
                      {adjunto.nombre}
                    </a>
                  ))}
                </p>
              ) : null}

              {mensaje.direccion === 'saliente' ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <BotonCopiar texto={mensaje.texto} etiqueta="Copiar el mensaje" />
                  {mensaje.estado === 'pendiente_envio_manual' && puedeEscribir ? (
                    mensaje.esProximoEnvio ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          correr(() => registrarEnvioAction({ obraId, contactoId: contacto.id }))
                        }
                        disabled={pendiente}
                      >
                        Marcar como enviado
                      </Button>
                    ) : (
                      <span className="text-xs text-neutral-500">
                        Se marca en orden: primero el de arriba.
                      </span>
                    )
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        {aviso ? (
          <p className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
            {aviso}
          </p>
        ) : null}
        {error ? <p className="text-sm text-red-700">{error}</p> : null}

        {puedeEscribir ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDialogo(true)}>
              Registrar respuesta
            </Button>
            <Link
              href={`/obras/${obraId}/conversaciones/${contacto.id}`}
              className={estilosBoton('ghost', 'sm')}
            >
              Registrar un mensaje entrante
            </Link>
          </div>
        ) : null}

        <DialogoRespuesta
          abierto={dialogo}
          proveedor={contacto.proveedor}
          texto={texto}
          preview={preview}
          pendiente={pendiente}
          error={error}
          onTexto={(valor) => {
            setTexto(valor);
            setPreview(null);
          }}
          onLeer={leerPresupuesto}
          onConfirmar={confirmar}
          onCerrar={() => {
            setDialogo(false);
            setPreview(null);
            setError(null);
          }}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Diálogo de «Registrar respuesta»
// ---------------------------------------------------------------------------

interface DialogoRespuestaProps {
  abierto: boolean;
  proveedor: string;
  texto: string;
  preview: PreviewPresupuesto | null;
  pendiente: boolean;
  error: string | null;
  onTexto: (valor: string) => void;
  onLeer: () => void;
  onConfirmar: () => void;
  onCerrar: () => void;
}

/**
 * Pegar → leer → **mirar lo que se va a guardar** → confirmar.
 *
 * El preview no es decorativo: muestra las líneas que se leyeron, lo que el
 * saneo va a descartar (P5 lo audita, pero el core no puede avisar por sí solo)
 * y la conciliación que va a quedar. Confirmar manda esas líneas tal cual, así
 * que lo que se ve es exactamente lo que se guarda.
 */
function DialogoRespuesta({
  abierto,
  proveedor,
  texto,
  preview,
  pendiente,
  error,
  onTexto,
  onLeer,
  onConfirmar,
  onCerrar,
}: DialogoRespuestaProps) {
  return (
    <Dialog
      open={abierto}
      onClose={onCerrar}
      title={`Registrar la respuesta de ${proveedor}`}
      footer={
        <>
          <Button variant="ghost" onClick={onCerrar} disabled={pendiente}>
            Cancelar
          </Button>
          {preview ? (
            <Button onClick={onConfirmar} disabled={pendiente}>
              {pendiente ? 'Guardando…' : 'Confirmar y guardar'}
            </Button>
          ) : (
            <Button onClick={onLeer} disabled={pendiente || texto.trim() === ''}>
              {pendiente ? 'Leyendo…' : 'Leer el presupuesto'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">
            Pegá el presupuesto tal como lo mandó
          </span>
          <textarea
            value={texto}
            onChange={(evento) => onTexto(evento.target.value)}
            rows={8}
            className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs text-neutral-900"
            placeholder={'31,68 m2 Placa de roca de yeso 12,5 mm $ 8.000 $ 253.440\nTOTAL $ 358.440\nValidez: 10 días'}
          />
        </label>

        {error ? <p className="text-sm text-red-700">{error}</p> : null}

        {preview ? <ResumenPreview preview={preview} /> : null}
      </div>
    </Dialog>
  );
}

function ResumenPreview({ preview }: { preview: PreviewPresupuesto }) {
  const { metadatos } = preview;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-800">
        <Badge tone="info">Fidelidad {formatearNumero(preview.score * 100)}%</Badge>
        <span>
          {preview.lineas.length} {preview.lineas.length === 1 ? 'línea leída' : 'líneas leídas'}
        </span>
        <span>Total declarado: {metadatos.total === null ? 'no lo dijo' : importe(metadatos.total)}</span>
        <span>
          IVA:{' '}
          {metadatos.incluyeIva === null
            ? 'no lo aclaró'
            : metadatos.incluyeIva
              ? 'incluido'
              : 'discriminado'}
        </span>
        {metadatos.validezDias !== null ? <span>Validez {metadatos.validezDias} días</span> : null}
        {metadatos.plazoDias !== null ? <span>Entrega {metadatos.plazoDias} días</span> : null}
        {metadatos.formaPago ? <span>Pago: {metadatos.formaPago}</span> : null}
      </div>

      {/* Lo que el saneo del borde de escritura va a descartar. El core lo
          audita, pero si no se muestra acá el usuario ve desaparecer un dato
          que cargó y no sabe por qué (P5, fix round 1). */}
      {preview.lineasDescartadas > 0 || preview.metadatosCorregidos.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {preview.lineasDescartadas > 0 ? (
            <p>
              {preview.lineasDescartadas === 1
                ? '1 línea no se va a guardar'
                : `${preview.lineasDescartadas} líneas no se van a guardar`}
              : no tienen descripción legible.
            </p>
          ) : null}
          {preview.metadatosCorregidos.length > 0 ? (
            <p>
              Estos datos quedan en blanco porque el valor era imposible:{' '}
              {preview.metadatosCorregidos.join(', ')}. Un precio que no se entiende se anula, no se
              adivina.
            </p>
          ) : null}
        </div>
      ) : null}

      {preview.alertas.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md border border-red-300 bg-red-50 px-3 py-2">
          {preview.alertas.map((alerta) => (
            <li key={alerta} className="text-xs text-red-800">
              {alerta}
            </li>
          ))}
        </ul>
      ) : null}

      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Ítem del pedido</TableHeaderCell>
            <TableHeaderCell>Lo que cotizó</TableHeaderCell>
            <TableHeaderCell>Match</TableHeaderCell>
            <TableHeaderCell numeric>Unitario</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {preview.filas.map((fila, indice) => (
            <TableRow key={`${fila.claveItem ?? 'extra'}-${indice}`}>
              <TableCell>
                <span className="block text-neutral-900">{fila.descripcionRfq ?? '—'}</span>
                <span className="block text-xs text-neutral-500">{fila.claveItem ?? 'sin pedir'}</span>
              </TableCell>
              <TableCell>
                <span className="block text-neutral-800">{fila.descripcionLinea ?? '—'}</span>
                <span className="block text-xs text-neutral-500">{fila.motivo}</span>
              </TableCell>
              <TableCell>
                <Badge tone={TONO_MATCH[fila.match]}>{ETIQUETA_MATCH[fila.match]}</Badge>
              </TableCell>
              <TableCell numeric>{importe(fila.precioUnitario)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {preview.repreguntas.length > 0 ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
          <p className="text-xs font-medium text-neutral-700">
            Al confirmar quedan{' '}
            {preview.repreguntas.length === 1
              ? '1 repregunta lista'
              : `${preview.repreguntas.length} repreguntas listas`}{' '}
            para mandar:
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {preview.repreguntas.map((repregunta) => (
              <li key={repregunta} className="text-xs text-neutral-600">
                {repregunta}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
