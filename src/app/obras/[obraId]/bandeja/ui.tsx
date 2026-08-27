'use client';

/**
 * Tarjetas de la bandeja de consultas.
 *
 * Cada consulta es una tarjeta con lo necesario para decidir sin salir de la
 * pantalla: qué falta, si frena la aprobación del rubro, en qué lámina está el
 * dato —el link resalta el hallazgo en el visor— y las acciones de un
 * clic. Cuando el hallazgo apunta a campos de una entidad, hay **un input por
 * campo** con su nombre en es-AR ("Ancho (m)", "Alto (m)"), no un "valor"
 * genérico: lo que se responde es el dato que falta, no un formulario. Y van
 * todos juntos, porque una carpintería sin acotar necesita el ancho **y** el
 * alto: preguntarlos de a uno hacía reaparecer la consulta.
 *
 * ## Proponer en vez de preguntar
 *
 * Si el sistema ya leyó el dato —con poca confianza, del rótulo o buscándolo en
 * la documentación— el input **viene lleno** con esa lectura y el botón dice
 * "Confirmar": el trabajo del arquitecto pasa de tipear decenas de medidas a
 * mirar y confirmar, corrigiendo solo lo que esté mal. La leyenda dice de dónde
 * salió cada propuesta, porque confirmar a ciegas no es confirmar.
 *
 * La selección múltiple vive acá (es estado de la pantalla); los filtros viven
 * en la URL (`page.tsx`), así la vista es compartible y no necesita JavaScript.
 */
import Link from 'next/link';
import { useState, useTransition } from 'react';

import {
  buscarEnDocumentacionAction,
  confirmarLoteAction,
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
import type {
  BBox,
  EstadoHallazgo,
  OrigenPropuesto,
  RubroId,
  TipoHallazgo,
} from '@/types/domain';

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

/** Dónde está lo que la consulta mira: lámina + recuadro, para el visor. */
export interface FuenteVista {
  laminaId: string;
  bbox: BBox;
}

/**
 * Lo que el sistema propone, **ya formateado en es-AR** por el server: los
 * valores entran tal cual en los inputs y el arquitecto los edita como texto,
 * sin traducir de "0.9" a "0,90" ni al revés.
 */
export interface PropuestaVista {
  /** `campo → valor` listo para el input ("0,90"). Para la escala, `escala`. */
  valores: Record<string, string>;
  origen: OrigenPropuesto;
  /** 0–1, o `null` si el origen no la reporta (el rótulo, por ejemplo). */
  confianza: number | null;
  /** La lámina donde se leyó, con su código y su recuadro. */
  fuente: (FuenteVista & { etiqueta: string }) | null;
}

export interface ConsultaVista {
  id: string;
  clave: string;
  tipo: TipoHallazgo;
  rubro: RubroId | null;
  descripcion: string;
  bloqueante: boolean;
  estado: EstadoHallazgo;
  /** Todos los campos de la entidad que hay que completar, en orden. */
  campos: string[];
  /** El primero de `campos`, o `null`. Atajo para lo que solo mira si hay uno. */
  campo: string | null;
  /** Nombre de la entidad apuntada, para decir sobre qué es la consulta. */
  entidad: string | null;
  /** `true` si es el bloqueo por escala de una lámina (RF-201). */
  esEscala: boolean;
  laminas: LaminaCitada[];
  /** Las fuentes con bbox: de acá sale el resaltado del visor. */
  fuentes: FuenteVista[];
  /** Lo que el sistema propone, o `null` si la consulta es una pregunta. */
  valorPropuesto: PropuestaVista | null;
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
      case 'valor': {
        // Con más de un campo la respuesta guarda el mapa entero: se lista
        // campo por campo, que es como se respondió.
        const valores = respuesta.valores;
        if (valores !== null && typeof valores === 'object') {
          return Object.entries(valores as Record<string, unknown>)
            .map(([campo, dato]) => `${etiquetaCampo(campo)}: ${String(dato)}`)
            .join(' · ');
        }
        return typeof respuesta.campo === 'string'
          ? `${etiquetaCampo(respuesta.campo)}: ${String(valor)}`
          : `Respondida con ${String(valor)}`;
      }
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

/** La clave con la que se guarda el input de la escala (no es un campo). */
const CLAVE_ESCALA = 'escala';
/** La clave del input de texto libre cuando la consulta no apunta a nada. */
const CLAVE_NOTA = 'nota';

/** Qué inputs muestra la tarjeta: la escala, los campos del target, o la nota. */
function clavesDeInput(consulta: ConsultaVista): string[] {
  if (consulta.esEscala) return [CLAVE_ESCALA];
  return consulta.campos.length > 0 ? consulta.campos : [CLAVE_NOTA];
}

/** Cada input arranca con lo que el sistema propone; vacío si no propone nada. */
function valoresIniciales(consulta: ConsultaVista): Record<string, string> {
  const propuesto = consulta.valorPropuesto?.valores ?? {};
  return Object.fromEntries(clavesDeInput(consulta).map((clave) => [clave, propuesto[clave] ?? '']));
}

/**
 * Identidad de la tarjeta **incluyendo lo que propone**.
 *
 * Los inputs se inicializan una sola vez, al montar. Si la propuesta llega
 * después —el botón «Buscar los datos en la documentación» las escribe y la
 * pantalla se revalida— la tarjeta se vuelve a renderizar con la misma `key` y
 * los inputs seguirían vacíos: el dato aparecería en el server y no en la
 * pantalla. Con la propuesta adentro de la key, React remonta la tarjeta y los
 * inputs nacen llenos.
 */
function claveDeTarjeta(consulta: ConsultaVista): string {
  const propuesto = consulta.valorPropuesto?.valores;
  if (!propuesto) return consulta.id;
  const firma = Object.entries(propuesto)
    .map(([campo, valor]) => `${campo}=${valor}`)
    .join('|');
  return `${consulta.id}:${firma}`;
}

/**
 * De dónde salió la propuesta, en una línea.
 *
 * No es decoración: confirmar sin saber si el dato lo leyó la búsqueda en la
 * planilla o el motor con un 62 % de confianza es firmar a ciegas.
 */
function leyendaDeOrigen(propuesta: PropuestaVista): string {
  const porcentaje =
    propuesta.confianza === null ? null : `${Math.round(propuesta.confianza * 100)} %`;

  switch (propuesta.origen) {
    case 'busqueda_dirigida': {
      const donde = propuesta.fuente ? ` en ${propuesta.fuente.etiqueta}` : ' en la documentación';
      return `propuesto por la búsqueda${donde}${porcentaje ? ` · ${porcentaje}` : ''}`;
    }
    case 'lectura_baja_confianza':
      return porcentaje === null
        ? 'leído del plano, sin confianza suficiente para computarlo solo'
        : `leído del plano con ${porcentaje} de confianza`;
    case 'rotulo':
      return 'leído del rótulo';
  }
}

interface TarjetaProps {
  obraId: string;
  consulta: ConsultaVista;
  seleccionada: boolean;
  onSeleccion: (id: string, valor: boolean) => void;
}

function TarjetaConsulta({ obraId, consulta, seleccionada, onSeleccion }: TarjetaProps) {
  const [valores, setValores] = useState<Record<string, string>>(() =>
    valoresIniciales(consulta),
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmandoDescarte, setConfirmandoDescarte] = useState(false);
  const [pendiente, iniciar] = useTransition();

  const abierta = consulta.estado === 'abierto';
  const campos = consulta.campos;
  const propuesta = consulta.valorPropuesto;
  const claves = clavesDeInput(consulta);
  // **Todos** los campos, no alguno: la consulta existe porque faltan los dos.
  // Responder solo el ancho la cerraría con la abertura igual de incomputable.
  const completa = claves.every((clave) => (valores[clave] ?? '').trim() !== '');

  function etiquetaDeClave(clave: string): string {
    if (clave === CLAVE_ESCALA) return 'Escala';
    if (clave === CLAVE_NOTA) return 'Nota';
    return etiquetaCampo(clave);
  }

  function esNumerica(clave: string): boolean {
    return clave !== CLAVE_ESCALA && clave !== CLAVE_NOTA && !CAMPOS_DE_TEXTO.has(clave);
  }

  function placeholderDe(clave: string): string {
    if (clave === CLAVE_ESCALA) return '1:100';
    if (clave === CLAVE_NOTA) return 'Escribí tu respuesta';
    return esNumerica(clave) ? '2,05' : 'Escribí tu respuesta';
  }

  function correr(accion: () => Promise<{ ok: true } | { ok: false; error: string }>): void {
    setError(null);
    iniciar(async () => {
      const resultado = await accion();
      if (!resultado.ok) setError(resultado.error);
      // Si salió bien la fila se recarga desde el server (la action revalida):
      // limpiar los inputs acá haría parpadear la propuesta antes de que llegue.
    });
  }

  function responder(): void {
    // Tres formas de responder, según a qué apunte la consulta. Sin campos ni
    // escala lo que se escribe es una nota: el server no escribe texto libre en
    // un atributo que el motor lee como medida (P4).
    if (consulta.esEscala) {
      correr(() =>
        responderHallazgoAction({
          obraId,
          hallazgoId: consulta.id,
          valor: valores[CLAVE_ESCALA] ?? '',
        }),
      );
      return;
    }
    if (campos.length > 0) {
      correr(() =>
        responderHallazgoAction({
          obraId,
          hallazgoId: consulta.id,
          valores: Object.fromEntries(campos.map((campo) => [campo, valores[campo] ?? ''])),
        }),
      );
      return;
    }
    correr(() =>
      responderHallazgoAction({
        obraId,
        hallazgoId: consulta.id,
        nota: valores[CLAVE_NOTA] ?? '',
      }),
    );
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
              {claves.map((clave) => (
                <div key={clave} className="w-48">
                  <Input
                    label={etiquetaDeClave(clave)}
                    inputMode={esNumerica(clave) ? 'decimal' : undefined}
                    placeholder={placeholderDe(clave)}
                    value={valores[clave] ?? ''}
                    onChange={(evento) =>
                      setValores((previos) => ({ ...previos, [clave]: evento.target.value }))
                    }
                    disabled={pendiente}
                  />
                </div>
              ))}
              {/* La escala se puede confirmar sin escribirla: el rótulo ya la trae. */}
              <Button
                size="sm"
                onClick={responder}
                disabled={pendiente || (!completa && !consulta.esEscala)}
              >
                {consulta.esEscala
                  ? 'Confirmar escala'
                  : propuesta !== null
                    ? 'Confirmar'
                    : 'Responder'}
              </Button>

              {campos.length > 0 ? (
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

              {/* La escala también es un supuesto, pero confirmarla por acá
                  cerraría la consulta sin marcar la lámina como confiable
                  (decisión 7): su botón es «Confirmar escala». */}
              {consulta.tipo === 'supuesto' && !consulta.esEscala ? (
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

            {propuesta ? (
              <p className="text-xs text-neutral-500">
                {leyendaDeOrigen(propuesta)}
                <span className="text-neutral-400"> · </span>
                revisalo y corregilo si no es lo que dice el plano.
              </p>
            ) : null}

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
  const [dialogo, setDialogo] = useState<'descartar' | 'confirmar' | null>(null);
  const [nota, setNota] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [pendiente, iniciar] = useTransition();

  const abiertas = grupos.flatMap((grupo) =>
    grupo.consultas.filter((consulta) => consulta.estado === 'abierto'),
  );
  const abiertasVisibles = abiertas.map((consulta) => consulta.id);
  const elegidas = seleccion.filter((id) => abiertasVisibles.includes(id));
  // Confirmar es responder con la propuesta: las que no tienen nada propuesto
  // el server las saltea, así que el botón se habilita con que haya UNA.
  const conPropuesta = abiertas.filter(
    (consulta) => consulta.valorPropuesto !== null && elegidas.includes(consulta.id),
  ).length;

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
      setDialogo(null);
    });
  }

  function confirmarSeleccionadas(): void {
    setError(null);
    setAviso(null);
    iniciar(async () => {
      const resultado = await confirmarLoteAction({ obraId, hallazgoIds: elegidas, nota });
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }
      // Las salteadas no son un error —una selección mezcla consultas con
      // propuesta y sin ella— pero callarlas dejaría creer que se confirmaron.
      if (resultado.salteadas > 0) {
        setAviso(
          resultado.salteadas === 1
            ? 'Una de las seleccionadas no tenía nada propuesto: sigue abierta, respondela a mano.'
            : `${resultado.salteadas} de las seleccionadas no tenían nada propuesto: siguen abiertas, respondelas a mano.`,
        );
      }
      setSeleccion([]);
      setNota('');
      setDialogo(null);
    });
  }

  function buscarEnDocumentacion(): void {
    setError(null);
    setAviso(null);
    iniciar(async () => {
      const resultado = await buscarEnDocumentacionAction({ obraId });
      if (!resultado.ok) setError(resultado.error);
      else setAviso('Busqué los datos que faltan en la documentación de la obra.');
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
          onClick={() => setDialogo('confirmar')}
          disabled={conPropuesta === 0 || pendiente}
          title={
            conPropuesta === 0
              ? 'Ninguna de las seleccionadas trae un valor propuesto para confirmar'
              : undefined
          }
        >
          Confirmar seleccionadas ({conPropuesta})
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => setDialogo('descartar')}
          disabled={elegidas.length === 0 || pendiente}
        >
          Descartar seleccionadas
        </Button>
        {/* Gasta créditos: es un botón explícito, no algo que pase solo. */}
        <Button size="sm" variant="ghost" onClick={buscarEnDocumentacion} disabled={pendiente}>
          Buscar los datos en la documentación
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
              key={claveDeTarjeta(consulta)}
              obraId={obraId}
              consulta={consulta}
              seleccionada={seleccion.includes(consulta.id)}
              onSeleccion={alternar}
            />
          ))}
        </section>
      ))}

      <Dialog
        open={dialogo === 'confirmar'}
        onClose={() => setDialogo(null)}
        title="Confirmar las consultas seleccionadas"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogo(null)} disabled={pendiente}>
              Cancelar
            </Button>
            <Button onClick={confirmarSeleccionadas} disabled={pendiente}>
              {pendiente ? 'Confirmando…' : 'Confirmar'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-700">
            {conPropuesta === 1
              ? 'Vas a dar por bueno el valor propuesto de 1 consulta.'
              : `Vas a dar por buenos los valores propuestos de ${conPropuesta} consultas.`}{' '}
            Los datos entran a la documentación de la obra con tu usuario y el cómputo se rehace.
            {elegidas.length > conPropuesta
              ? ` Las otras ${elegidas.length - conPropuesta} de la selección no tienen nada propuesto: quedan abiertas.`
              : ''}
          </p>
          <Input
            label="Nota (opcional)"
            placeholder="Verificado contra la planilla de carpinterías"
            value={nota}
            onChange={(evento) => setNota(evento.target.value)}
            disabled={pendiente}
          />
        </div>
      </Dialog>

      <Dialog
        open={dialogo === 'descartar'}
        onClose={() => setDialogo(null)}
        title="Descartar las consultas seleccionadas"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogo(null)} disabled={pendiente}>
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
