'use client';

/**
 * Tarjetas de la bandeja de consultas.
 *
 * Cada consulta es una tarjeta con lo necesario para decidir sin salir de la
 * pantalla: qué falta, si frena la aprobación del rubro, en qué lámina está el
 * dato —el link resalta el hallazgo en el visor— y las acciones de un
 * clic. Cuando el hallazgo apunta a un campo de una entidad, el input inline
 * pide **ese** campo con su nombre en es-AR ("Alto (m)"), no un "valor"
 * genérico: lo que se responde es el dato que falta, no un formulario.
 *
 * La selección múltiple vive acá (es estado de la pantalla); los filtros viven
 * en la URL (`page.tsx`), así la vista es compartible y no necesita JavaScript.
 */
import Link from 'next/link';
import { useState, useTransition } from 'react';

import {
  confirmarSupuestoAction,
  descartarHallazgoAction,
  descartarLoteAction,
  marcarExistenteAction,
  responderHallazgoAction,
} from '@/app/obras/[obraId]/bandeja/actions';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { EstadoHallazgo, RubroId, TipoHallazgo } from '@/types/domain';

// ---------------------------------------------------------------------------
// Vocabulario de la pantalla
// ---------------------------------------------------------------------------

/** Nombre en es-AR del campo que se completa al responder. */
export const ETIQUETA_CAMPO: Record<string, string> = {
  alturaM: 'Altura (m)',
  anchoM: 'Ancho (m)',
  altoM: 'Alto (m)',
  largoM: 'Largo (m)',
  espesorM: 'Espesor (m)',
  superficieM2: 'Superficie (m²)',
  perimetroM: 'Perímetro (m)',
  vanosM2: 'Vanos (m²)',
  caras: 'Caras',
  tipo: 'Sistema constructivo',
};

/** Los campos que no son una medida: se responden con texto, no con un número. */
const CAMPOS_DE_TEXTO = new Set(['tipo']);

export function etiquetaCampo(campo: string): string {
  return ETIQUETA_CAMPO[campo] ?? campo;
}

const ETIQUETA_TIPO: Record<TipoHallazgo, string> = {
  faltante: 'Falta un dato',
  inconsistencia: 'Inconsistencia',
  existente_confirmar: 'Confirmar existente',
  supuesto: 'Supuesto',
};

const TONO_TIPO: Record<TipoHallazgo, BadgeTone> = {
  faltante: 'error',
  inconsistencia: 'warn',
  existente_confirmar: 'info',
  supuesto: 'warn',
};

const ETIQUETA_ESTADO: Record<EstadoHallazgo, string> = {
  abierto: 'Abierta',
  respondido: 'Respondida',
  descartado: 'Descartada',
};

const TONO_ESTADO: Record<EstadoHallazgo, BadgeTone> = {
  abierto: 'neutral',
  respondido: 'ok',
  descartado: 'neutral',
};

// ---------------------------------------------------------------------------
// Datos que baja el server (todo serializable)
// ---------------------------------------------------------------------------

export interface LaminaCitada {
  laminaId: string;
  etiqueta: string;
}

export interface ConsultaVista {
  id: string;
  clave: string;
  tipo: TipoHallazgo;
  rubro: RubroId | null;
  descripcion: string;
  bloqueante: boolean;
  estado: EstadoHallazgo;
  /** Campo de la entidad que se completa al responder, si lo hay. */
  campo: string | null;
  /** Nombre de la entidad apuntada, para decir sobre qué es la consulta. */
  entidad: string | null;
  /** `true` si es el bloqueo por escala de una lámina (RF-201). */
  esEscala: boolean;
  laminas: LaminaCitada[];
  respuesta: Record<string, unknown> | null;
}

export interface GrupoConsultas {
  /** `null` es el grupo "Generales" (consultas de obra, sin rubro). */
  rubro: RubroId | null;
  titulo: string;
  consultas: ConsultaVista[];
}

// ---------------------------------------------------------------------------

/** La respuesta guardada, en castellano. */
function textoRespuesta(consulta: ConsultaVista): string {
  const respuesta = consulta.respuesta;
  if (!respuesta) return 'Sin respuesta registrada.';

  const nota = typeof respuesta.nota === 'string' ? respuesta.nota : null;
  const valor = respuesta.valor;
  const cabeza = ((): string => {
    switch (respuesta.tipo) {
      case 'valor':
        return typeof respuesta.campo === 'string'
          ? `${etiquetaCampo(respuesta.campo)}: ${String(valor)}`
          : `Respondida con ${String(valor)}`;
      case 'escala':
        return valor === undefined ? 'Escala confirmada.' : `Escala confirmada: ${String(valor)}`;
      case 'existente':
        return 'Marcada como existente: no está dentro del alcance de la obra.';
      case 'supuesto_confirmado':
        return 'Supuesto confirmado.';
      case 'descartado':
        return 'Descartada.';
      case 'nota':
        return nota ?? 'Respondida.';
      default:
        return typeof respuesta.auto === 'string' ? respuesta.auto : 'Resuelta.';
    }
  })();

  return nota && respuesta.tipo !== 'nota' ? `${cabeza} — ${nota}` : cabeza;
}

// ---------------------------------------------------------------------------

interface TarjetaProps {
  obraId: string;
  consulta: ConsultaVista;
  seleccionada: boolean;
  onSeleccion: (id: string, valor: boolean) => void;
}

function TarjetaConsulta({ obraId, consulta, seleccionada, onSeleccion }: TarjetaProps) {
  const [texto, setTexto] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmandoDescarte, setConfirmandoDescarte] = useState(false);
  const [pendiente, iniciar] = useTransition();

  const abierta = consulta.estado === 'abierto';
  const campo = consulta.campo;
  const esNumerico = campo !== null && !CAMPOS_DE_TEXTO.has(campo);

  const etiquetaInput = consulta.esEscala
    ? 'Escala'
    : campo !== null
      ? etiquetaCampo(campo)
      : 'Nota';
  const placeholder = consulta.esEscala ? '1:100' : esNumerico ? '2,05' : 'Escribí tu respuesta';

  function correr(accion: () => Promise<{ ok: true } | { ok: false; error: string }>): void {
    setError(null);
    iniciar(async () => {
      const resultado = await accion();
      if (!resultado.ok) setError(resultado.error);
      else setTexto('');
    });
  }

  function responder(): void {
    // Sin `campo` ni escala, lo que se escribe es una nota: el server no
    // escribe texto libre en un atributo que el motor lee como medida (P4).
    const payload =
      consulta.esEscala || campo !== null
        ? { obraId, hallazgoId: consulta.id, valor: texto }
        : { obraId, hallazgoId: consulta.id, nota: texto };
    correr(() => responderHallazgoAction(payload));
  }

  return (
    <Card className={consulta.bloqueante && abierta ? 'border-red-200' : undefined}>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {abierta ? (
            <input
              type="checkbox"
              checked={seleccionada}
              onChange={(evento) => onSeleccion(consulta.id, evento.target.checked)}
              aria-label={`Seleccionar la consulta ${consulta.clave}`}
              className="size-4 rounded border-neutral-300"
            />
          ) : null}
          <Badge tone={TONO_TIPO[consulta.tipo]}>{ETIQUETA_TIPO[consulta.tipo]}</Badge>
          {/* Solo mientras está abierta: una consulta respondida o descartada ya
              no frena nada, y el badge rojo al lado de «Respondida» hacía creer
              que sí. Es el mismo criterio que el borde de la Card, arriba. El
              rojo lo pone el `tone`; el emoji sobraba y ningún otro badge de la
              app lleva uno. */}
          {consulta.bloqueante && abierta ? (
            <Badge
              tone="error"
              title={
                // Una consulta de obra (sin rubro) no se puede atribuir a uno:
                // frena a todos, y el gate la cuenta en todos.
                consulta.rubro === null
                  ? 'Frena la aprobación de todos los rubros'
                  : 'Frena la aprobación del rubro'
              }
            >
              Bloqueante
            </Badge>
          ) : null}
          {abierta ? null : (
            <Badge tone={TONO_ESTADO[consulta.estado]}>{ETIQUETA_ESTADO[consulta.estado]}</Badge>
          )}
          <span className="ml-auto font-mono text-xs text-neutral-400">{consulta.clave}</span>
        </div>

        <p className="text-sm text-neutral-800">{consulta.descripcion}</p>

        {consulta.entidad ? (
          <p className="text-xs text-neutral-500">Sobre: {consulta.entidad}</p>
        ) : null}

        {consulta.laminas.length > 0 ? (
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-neutral-500">Citada en:</span>
            {consulta.laminas.map((lamina) => (
              <Link
                key={lamina.laminaId}
                href={`/obras/${obraId}/laminas/${lamina.laminaId}?highlight=${consulta.id}`}
                className="font-medium text-neutral-900 underline"
              >
                {lamina.etiqueta}
              </Link>
            ))}
          </p>
        ) : null}

        {abierta ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <Input
                  label={etiquetaInput}
                  inputMode={esNumerico ? 'decimal' : undefined}
                  placeholder={placeholder}
                  value={texto}
                  onChange={(evento) => setTexto(evento.target.value)}
                  disabled={pendiente}
                />
              </div>
              {/* La escala se puede confirmar sin escribirla: el rótulo ya la trae. */}
              <Button
                size="sm"
                onClick={responder}
                disabled={pendiente || (texto.trim() === '' && !consulta.esEscala)}
              >
                {consulta.esEscala ? 'Confirmar escala' : 'Responder'}
              </Button>

              {campo !== null ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    correr(() => marcarExistenteAction({ obraId, hallazgoId: consulta.id }))
                  }
                  disabled={pendiente}
                >
                  Ya está construido
                </Button>
              ) : null}

              {consulta.tipo === 'supuesto' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    correr(() => confirmarSupuestoAction({ obraId, hallazgoId: consulta.id }))
                  }
                  disabled={pendiente}
                >
                  Confirmar supuesto
                </Button>
              ) : null}

              {confirmandoDescarte ? (
                <span className="flex items-center gap-1">
                  <span className="text-xs text-neutral-600">¿Descartar?</span>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setConfirmandoDescarte(false);
                      correr(() => descartarHallazgoAction({ obraId, hallazgoId: consulta.id }));
                    }}
                    disabled={pendiente}
                  >
                    Sí
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmandoDescarte(false)}
                    disabled={pendiente}
                  >
                    No
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmandoDescarte(true)}
                  disabled={pendiente}
                >
                  Descartar
                </Button>
              )}
            </div>

            {error ? <p className="text-sm text-red-700">{error}</p> : null}
          </div>
        ) : (
          <p className="rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
            {textoRespuesta(consulta)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export interface BandejaConsultasProps {
  obraId: string;
  grupos: GrupoConsultas[];
}

export function BandejaConsultas({ obraId, grupos }: BandejaConsultasProps) {
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [dialogo, setDialogo] = useState(false);
  const [nota, setNota] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  const abiertasVisibles = grupos.flatMap((grupo) =>
    grupo.consultas.filter((consulta) => consulta.estado === 'abierto').map((c) => c.id),
  );
  const elegidas = seleccion.filter((id) => abiertasVisibles.includes(id));

  function alternar(id: string, valor: boolean): void {
    setSeleccion((previa) => (valor ? [...previa, id] : previa.filter((otro) => otro !== id)));
  }

  function descartarSeleccionadas(): void {
    setError(null);
    setAviso(null);
    iniciar(async () => {
      const resultado = await descartarLoteAction({ obraId, hallazgoIds: elegidas, nota });
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      // Alguien pudo responder una de las seleccionadas mientras esta pantalla
      // envejecía: esas quedan como están y hay que decirlo.
      if (resultado.respondidas > 0) {
        setAviso(
          resultado.respondidas === 1
            ? 'Una de las seleccionadas ya estaba respondida: la dejé como está para no borrar la respuesta.'
            : `${resultado.respondidas} de las seleccionadas ya estaban respondidas: las dejé como están para no borrar sus respuestas.`,
        );
      }
      setSeleccion([]);
      setNota('');
      setDialogo(false);
    });
  }

  if (grupos.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-neutral-900">No hay consultas para mostrar.</p>
        <p className="mt-1 text-sm text-neutral-600">
          Aparecen solas cuando el análisis encuentra un dato que falta o que no cierra. Probá con
          otro filtro si estás buscando alguna que ya resolviste.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setSeleccion(elegidas.length === abiertasVisibles.length ? [] : abiertasVisibles)}
          disabled={abiertasVisibles.length === 0}
        >
          {elegidas.length === abiertasVisibles.length && abiertasVisibles.length > 0
            ? 'Deseleccionar todas'
            : 'Seleccionar todas'}
        </Button>
        <span className="text-sm text-neutral-600">
          {elegidas.length === 0
            ? 'Ninguna seleccionada'
            : elegidas.length === 1
              ? '1 consulta seleccionada'
              : `${elegidas.length} consultas seleccionadas`}
        </span>
        <Button
          size="sm"
          variant="danger"
          onClick={() => setDialogo(true)}
          disabled={elegidas.length === 0 || pendiente}
        >
          Descartar seleccionadas
        </Button>
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {aviso ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {aviso}
        </p>
      ) : null}

      {grupos.map((grupo) => (
        <section key={grupo.rubro ?? 'generales'} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-neutral-900">
            {grupo.titulo}
            <span className="ml-2 text-xs font-normal text-neutral-500 tabular-nums">
              {grupo.consultas.length}
            </span>
          </h2>
          {grupo.consultas.map((consulta) => (
            <TarjetaConsulta
              key={consulta.id}
              obraId={obraId}
              consulta={consulta}
              seleccionada={seleccion.includes(consulta.id)}
              onSeleccion={alternar}
            />
          ))}
        </section>
      ))}

      <Dialog
        open={dialogo}
        onClose={() => setDialogo(false)}
        title="Descartar las consultas seleccionadas"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogo(false)} disabled={pendiente}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={descartarSeleccionadas} disabled={pendiente}>
              {pendiente ? 'Descartando…' : 'Descartar'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-700">
            {elegidas.length === 1
              ? 'Vas a dar por no aplicable 1 consulta. Deja de frenar la aprobación del rubro'
              : `Vas a dar por no aplicables ${elegidas.length} consultas. Dejan de frenar la aprobación del rubro`}{' '}
            y queda registrado con tu usuario. No se borra nada: las podés seguir viendo con el
            filtro «Descartadas».
          </p>
          <Input
            label="Motivo (opcional)"
            placeholder="No aplica a esta etapa"
            value={nota}
            onChange={(evento) => setNota(evento.target.value)}
            disabled={pendiente}
          />
        </div>
      </Dialog>
    </div>
  );
}
