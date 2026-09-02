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
 * ## El plano al lado, no a un click de distancia
 *
 * "Sin salir de la pantalla" era mentira a medias: para entender de qué dato le
 * están hablando, el arquitecto tenía que hacer click en la lámina citada,
 * esperar que cargara **otra** página con el visor, mirar, volver atrás y
 * recién ahí contestar. Ahora la lista comparte la pantalla con un `PanelVisor`
 * a la derecha (apilado en pantallas chicas) y elegir una lámina la carga ahí,
 * con los recuadros de **esa** consulta resaltados y sin navegar.
 *
 * El primer recuadro es el de la propuesta: el lugar exacto donde el sistema
 * dice haber leído el dato. Es lo que hay que mirar para confirmar, y es a
 * donde el overlay scrollea.
 *
 * Los `?highlight=` no se van: el contrato de `src/app/CLAUDE.md` §4 sigue
 * intacto y cada consulta ofrece "Abrir en página completa" para cuando el
 * plano necesita toda la pantalla.
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
import { PanelVisor } from '@/components/viewer/panel-visor';
import type { FuenteVista } from './plano';
export type { FuenteVista } from './plano';

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

/**
 * Un dato de obra, listo para la tarjeta. Todo lo arma el server: el nombre en
 * castellano sale de `etiquetaDeDatoObra()` y el nombre del input de
 * `CAMPO_DATO_OBRA`, que es la misma clave con la que el resolver lo lee.
 */
export interface DatoObraVista {
  /** `altura_local.PB` — la clave de `datos_obra`, para el rastro. */
  clave: string;
  /** "Altura de local en PB" — cómo se lo nombra al arquitecto. */
  etiqueta: string;
  /** "m", o `null` si el dato es un texto (un solado, un revestimiento). */
  unidad: string | null;
  /** El nombre del input, que es el que el server acepta. */
  campo: string;
  /** Cuántas entidades lo están esperando: es el sentido de preguntarlo una vez. */
  afectadas: number;
}

export interface ConsultaVista {
  id: string;
  /**
   * La clave técnica (`dato_obra.altura_local.PB`). Es el identificador
   * estable de la consulta y sirve para reconocer una fila entre gente que
   * conoce el sistema; **no** es un nombre para leer. Todo lo que se muestra o
   * se lee en voz alta usa `nombreDeConsulta()`.
   */
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
  /**
   * Puesto ⇒ la consulta pide un **hecho de la obra** y no un campo de una
   * entidad (§5.2): un solo input, y responderlo escribe `datos_obra` una vez
   * para todas las entidades que lo estaban esperando.
   */
  datoObra: DatoObraVista | null;
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
      case 'dato_obra':
        return `Dato de obra cargado: ${String(valor)}`;
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
  // Un dato de obra pide UN valor y su nombre lo dice la clave del dato, no un
  // campo de dominio: el input se llama como el server lo espera leer.
  if (consulta.datoObra) return [consulta.datoObra.campo];
  return consulta.campos.length > 0 ? consulta.campos : [CLAVE_NOTA];
}

/** Cada input arranca con lo que el sistema propone; vacío si no propone nada. */
function valoresIniciales(consulta: ConsultaVista): Record<string, string> {
  const propuesto = consulta.valorPropuesto?.valores ?? {};
  return Object.fromEntries(clavesDeInput(consulta).map((clave) => [clave, propuesto[clave] ?? '']));
}

/**
 * `true` si la propuesta alcanza para cerrar la consulta sin dejar nada afuera.
 *
 * El server saltea las propuestas incompletas —confirmar el ancho sin el alto
 * cerraría la consulta para siempre con la abertura igual de incomputable— así
 * que el contador del botón tiene que contar lo mismo que se va a confirmar. Si
 * no, dice «Confirmar seleccionadas (5)» y confirma tres.
 */
function propuestaCompleta(consulta: ConsultaVista): boolean {
  const propuesto = consulta.valorPropuesto?.valores;
  if (!propuesto) return false;
  return clavesDeInput(consulta).every((clave) => (propuesto[clave] ?? '').trim() !== '');
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

// ---------------------------------------------------------------------------
// Qué se abre en el panel de al lado (lógica pura, testeada en
// `tests/unit/bandeja-plano.test.ts`)
// ---------------------------------------------------------------------------

/** Una lámina que la consulta permite abrir en el panel. */
export interface LaminaMirable {
  laminaId: string;
  etiqueta: string;
  /** `true` si es la lámina donde el sistema dice haber leído lo que propone. */
  esFuenteDeLaPropuesta: boolean;
}

/** Lo que el panel de la derecha está mostrando. */
export interface Mirada {
  consultaId: string;
  laminaId: string;
  /**
   * Los recuadros a resaltar. **Se guarda en el estado tal cual sale de acá**,
   * nunca se recalcula por render: `Overlay` scrollea con un
   * `useEffect(…, [destacados])` y un array nuevo en cada render scrollearía
   * de más.
   */
  destacados: BBox[];
  etiqueta: string;
}

/**
 * Las láminas que esta consulta puede abrir, **la primera es la que abre el
 * botón por defecto**: la de la propuesta si el sistema propone algo, y si no
 * la primera que la consulta cita.
 *
 * El orden no es capricho. Cuando la búsqueda dirigida encuentra el ancho de
 * FP01 en la planilla de carpinterías, la consulta está citada en la planta
 * (A-01) pero el dato se leyó en DET00: abrir A-01 mostraría el hueco del que
 * se pregunta, no la fila de la que salió el número que hay que confirmar.
 *
 * Solo entran las láminas que la página supo nombrar. Una fuente que apunta a
 * una lámina que no está en la obra tampoco se podría traer: la ruta de marcas
 * le contestaría 404 al panel.
 */
export function laminasDeConsulta(consulta: ConsultaVista): LaminaMirable[] {
  const opciones: LaminaMirable[] = [];
  const vistas = new Set<string>();

  const fuente = consulta.valorPropuesto?.fuente ?? null;
  if (fuente !== null) {
    vistas.add(fuente.laminaId);
    opciones.push({
      laminaId: fuente.laminaId,
      etiqueta: fuente.etiqueta,
      esFuenteDeLaPropuesta: true,
    });
  }

  for (const lamina of consulta.laminas) {
    if (vistas.has(lamina.laminaId)) continue;
    vistas.add(lamina.laminaId);
    opciones.push({ ...lamina, esFuenteDeLaPropuesta: false });
  }

  return opciones;
}

/**
 * Los recuadros de **esta** consulta en **esa** lámina, sin repetidos.
 *
 * El de la propuesta va primero porque es el que el arquitecto tiene que mirar
 * para confirmar —es el lugar exacto del que el sistema dice haber sacado el
 * dato— y porque `Overlay` scrollea al primero.
 */
export function destacadosDeConsulta(consulta: ConsultaVista, laminaId: string): BBox[] {
  const bboxes: BBox[] = [];
  const vistos = new Set<string>();

  function sumar(bbox: BBox): void {
    const clave = bbox.join(',');
    if (vistos.has(clave)) return;
    vistos.add(clave);
    bboxes.push(bbox);
  }

  const fuente = consulta.valorPropuesto?.fuente ?? null;
  if (fuente !== null && fuente.laminaId === laminaId) sumar(fuente.bbox);
  for (const otra of consulta.fuentes) {
    if (otra.laminaId === laminaId) sumar(otra.bbox);
  }

  return bboxes;
}

/**
 * Cómo se llama una consulta cuando hay que nombrarla: en el título del panel,
 * en el `aria-label` de su checkbox, al lado del recuadro que se está mirando.
 *
 * Nunca la clave cruda. `dato_obra.altura_local.PB` es un identificador de base
 * de datos, y en el `aria-label` era peor todavía: un lector de pantalla leía
 * «Seleccionar la consulta dato obra punto altura guion bajo local punto PB».
 * El nombre de la entidad manda —«V5»—, después el del hecho de obra
 * («Altura de local en PB»), y la clave queda de último recurso para cuando la
 * consulta no apunta a ninguno de los dos.
 */
export function nombreDeConsulta(consulta: ConsultaVista): string {
  if (consulta.entidad !== null) return consulta.entidad;
  if (consulta.datoObra !== null) return consulta.datoObra.etiqueta;
  // La de escala no apunta a ninguna de las dos y su clave es `escala.<uuid>`,
  // que en el título del panel se leía «A-01 · escala.9f3c…».
  if (consulta.esEscala) return 'la escala de la lámina';
  return consulta.clave;
}

/**
 * Lo que hay que cargar en el panel para ver una consulta en una lámina, o
 * `null` si esa lámina no es una de las que la consulta puede abrir.
 *
 * El `null` no es defensa por las dudas: la lista de láminas la arma la página
 * con lo que hay en la obra, y una lámina borrada entre el render y el click
 * no tiene que dejar el panel pidiendo un 404.
 */
export function armarMirada(consulta: ConsultaVista, laminaId: string): Mirada | null {
  const elegida =
    laminasDeConsulta(consulta).find((opcion) => opcion.laminaId === laminaId) ?? null;
  if (elegida === null) return null;

  return {
    consultaId: consulta.id,
    laminaId: elegida.laminaId,
    destacados: destacadosDeConsulta(consulta, elegida.laminaId),
    etiqueta: `${elegida.etiqueta} · ${nombreDeConsulta(consulta)}`,
  };
}

/**
 * La mirada que sigue siendo válida, o `null`.
 *
 * Confirmar o descartar revalida la pantalla y la consulta desaparece del
 * filtro «Abiertas»: dejar el plano abierto con el nombre de algo que ya no
 * está sería mostrar una decisión que ya se tomó. El estado **no** se limpia
 * —volver al filtro donde la consulta vive la vuelve a mostrar—, se filtra acá,
 * en el render, para no renderizar dos veces con un efecto.
 */
export function miradaVigente(
  mirada: Mirada | null,
  grupos: readonly GrupoConsultas[],
): Mirada | null {
  if (mirada === null) return null;
  const sigue = grupos.some((grupo) =>
    grupo.consultas.some((consulta) => consulta.id === mirada.consultaId),
  );
  return sigue ? mirada : null;
}

/**
 * El `destacados` de "no hay nada elegido", **una sola vez**.
 *
 * Un `?? []` acá abajo sería un array nuevo por render y volvería a disparar el
 * efecto de scroll de `Overlay`. Es una constante de módulo, no una decoración.
 */
const SIN_DESTACADOS: readonly BBox[] = [];

// ---------------------------------------------------------------------------

interface TarjetaProps {
  obraId: string;
  consulta: ConsultaVista;
  seleccionada: boolean;
  onSeleccion: (id: string, valor: boolean) => void;
  /** La lámina que el panel está mostrando de **esta** consulta, o `null`. */
  laminaEnPanel: string | null;
  onVer: (consulta: ConsultaVista, laminaId: string) => void;
}

function TarjetaConsulta({
  obraId,
  consulta,
  seleccionada,
  onSeleccion,
  laminaEnPanel,
  onVer,
}: TarjetaProps) {
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
  const mirables = laminasDeConsulta(consulta);
  // **Todos** los campos, no alguno: la consulta existe porque faltan los dos.
  // Responder solo el ancho la cerraría con la abertura igual de incomputable.
  const completa = claves.every((clave) => (valores[clave] ?? '').trim() !== '');

  const dato = consulta.datoObra;

  function etiquetaDeClave(clave: string): string {
    if (clave === CLAVE_ESCALA) return 'Escala';
    if (clave === CLAVE_NOTA) return 'Nota';
    // El dato de obra se nombra por lo que es ("Altura de local en PB (m)"), no
    // por su clave: `altura_local.PB` es un identificador nuestro.
    if (dato) return dato.unidad === null ? dato.etiqueta : `${dato.etiqueta} (${dato.unidad})`;
    return etiquetaCampo(clave);
  }

  function esNumerica(clave: string): boolean {
    if (dato) return dato.unidad !== null;
    return clave !== CLAVE_ESCALA && clave !== CLAVE_NOTA && !CAMPOS_DE_TEXTO.has(clave);
  }

  function placeholderDe(clave: string): string {
    if (clave === CLAVE_ESCALA) return '1:100';
    if (clave === CLAVE_NOTA) return 'Escribí tu respuesta';
    if (dato) return dato.unidad === null ? 'Escribí el dato' : '2,60';
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
    // Un dato de obra no es un campo de ninguna entidad: se manda con el
    // nombre que el resolver espera y escribe `datos_obra`, no un atributo.
    if (dato) {
      correr(() =>
        responderHallazgoAction({
          obraId,
          hallazgoId: consulta.id,
          valores: { [dato.campo]: valores[dato.campo] ?? '' },
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
    <Card
      className={[
        // La que se está mirando en el panel, marcada: con varias tarjetas
        // abiertas hay que saber de cuál es el recuadro rojo de la derecha.
        // Gana al borde rojo del bloqueante — el badge sigue diciéndolo.
        laminaEnPanel !== null
          ? 'border-neutral-900 ring-1 ring-neutral-900'
          : consulta.bloqueante && abierta
            ? 'border-red-200'
            : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {abierta ? (
            <input
              type="checkbox"
              checked={seleccionada}
              onChange={(evento) => onSeleccion(consulta.id, evento.target.checked)}
              aria-label={`Seleccionar la consulta sobre ${nombreDeConsulta(consulta)}`}
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
          {/* La clave técnica queda —sirve para hablar de una fila con
              nosotros— pero deja de ser lo único que nombra a la consulta. El
              nombre legible se agrega solo cuando aporta algo: la entidad ya
              sale abajo en «Sobre:», así que acá el que faltaba era el del
              hecho de obra, que no tiene otro lugar donde aparecer. */}
          <span className="ml-auto flex flex-wrap items-baseline gap-2">
            {consulta.datoObra ? (
              <span className="text-xs text-neutral-500">{consulta.datoObra.etiqueta}</span>
            ) : null}
            <span
              className="font-mono text-xs text-neutral-400"
              title="Identificador de la consulta"
            >
              {consulta.clave}
            </span>
          </span>
        </div>

        <p className="text-sm text-neutral-800">{consulta.descripcion}</p>

        {consulta.entidad ? (
          <p className="text-xs text-neutral-500">Sobre: {consulta.entidad}</p>
        ) : null}

        {/* Por qué esta consulta es una y no N: el hecho es de la obra, no de
            un elemento. Responderla computa a todos los que lo esperaban. */}
        {consulta.datoObra ? (
          <p className="text-xs text-neutral-500">
            Es un dato de toda la obra: se responde una vez y{' '}
            {consulta.datoObra.afectadas === 1
              ? 'el elemento que lo esperaba se computa solo'
              : `los ${consulta.datoObra.afectadas} elementos que lo esperaban se computan solos`}
            .
          </p>
        ) : null}

        {/* Cada lámina es un botón, no un link: carga el plano en el panel de
            al lado sin sacar al arquitecto de la consulta que está contestando.
            El link a la página completa queda al final, para cuando el plano
            necesita toda la pantalla (contrato `?highlight=`, app/CLAUDE.md §4). */}
        {mirables.length > 0 ? (
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-neutral-500">Ver en el plano:</span>
            {mirables.map((lamina) => {
              const activa = laminaEnPanel === lamina.laminaId;
              return (
                <button
                  key={lamina.laminaId}
                  type="button"
                  aria-pressed={activa}
                  title={
                    lamina.esFuenteDeLaPropuesta
                      ? 'Acá dice el sistema haber leído el dato que propone'
                      : undefined
                  }
                  onClick={() => onVer(consulta, lamina.laminaId)}
                  className={[
                    'rounded-full border px-2 py-0.5 font-medium transition-colors',
                    activa
                      ? 'border-neutral-900 bg-neutral-900 text-white'
                      : 'border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100',
                  ].join(' ')}
                >
                  {lamina.etiqueta}
                  {lamina.esFuenteDeLaPropuesta ? ' · dato propuesto' : ''}
                </button>
              );
            })}
            {/* Va a la primera de `mirables` —la de la propuesta si hay— o sea
                la misma que muestra el panel de al lado: el link a pantalla
                completa abre lo que el arquitecto está mirando, no otra cosa.
                Antes iba a una lámina **citada** a propósito, porque
                `resolverDestacado` resolvía `?highlight=` solo contra
                `hallazgos.laminas_json` y en la lámina de la propuesta no
                encontraba nada que resaltar. Hoy resuelve también contra
                `valorPropuesto.fuente` (`marcas.ts`, `fuentesDeConsulta`). */}
            {mirables.length > 0 ? (
              <Link
                href={`/obras/${obraId}/laminas/${mirables[0]!.laminaId}?highlight=${consulta.id}`}
                className="text-neutral-600 underline hover:text-neutral-900"
              >
                Abrir en página completa
              </Link>
            ) : null}
          </p>
        ) : null}

        {abierta ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
              {claves.map((clave) => (
                // El dato de obra lleva más ancho: su etiqueta es una frase
                // («Altura de revestimiento en baño (m)»), no dos palabras.
                <div key={clave} className={dato ? 'w-72' : 'w-48'}>
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
  const [mirada, setMirada] = useState<Mirada | null>(null);
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
  // Confirmar es responder con la propuesta: el server saltea las que no traen
  // nada propuesto y las que lo traen a medias, así que el contador cuenta
  // exactamente eso — lo que el botón va a confirmar de verdad.
  const confirmables = abiertas.filter(
    (consulta) => elegidas.includes(consulta.id) && propuestaCompleta(consulta),
  ).length;

  // La consulta que el panel muestra tiene que seguir estando en la lista
  // (`miradaVigente`, pinneada en `tests/unit/bandeja-plano.test.ts`).
  const enPanel = miradaVigente(mirada, grupos);

  function alternar(id: string, valor: boolean): void {
    setSeleccion((previa) => (valor ? [...previa, id] : previa.filter((otro) => otro !== id)));
  }

  /**
   * Abrir una lámina de una consulta en el panel.
   *
   * La `Mirada` entra **entera** al estado, con su array de destacados adentro:
   * de ahí sale la referencia estable que `PanelVisor` necesita.
   */
  function ver(consulta: ConsultaVista, laminaId: string): void {
    setMirada(armarMirada(consulta, laminaId));
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
            ? 'Una de las seleccionadas no traía todo lo que la consulta pide: sigue abierta, respondela a mano.'
            : `${resultado.salteadas} de las seleccionadas no traían todo lo que la consulta pide: siguen abiertas, respondelas a mano.`,
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
          disabled={confirmables === 0 || pendiente}
          title={
            confirmables === 0
              ? 'Ninguna de las seleccionadas trae todo lo que hace falta para confirmarla'
              : undefined
          }
        >
          Confirmar seleccionadas ({confirmables})
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

      {/* Dos columnas desde `lg`: la lista a la izquierda y el plano a la
          derecha, pegado al scroll. Apilado en pantallas chicas, con el panel
          plegable para que no empuje la lista fuera de la vista. */}
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
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
                  laminaEnPanel={enPanel?.consultaId === consulta.id ? enPanel.laminaId : null}
                  onVer={ver}
                />
              ))}
            </section>
          ))}
        </div>

        <div className="min-w-0 lg:sticky lg:top-4">
          <PanelVisor
            laminaId={enPanel?.laminaId ?? null}
            // La referencia sale del estado o de la constante de módulo: nunca
            // un `[]` nuevo por render (ver `SIN_DESTACADOS`).
            destacados={enPanel?.destacados ?? SIN_DESTACADOS}
            etiqueta={enPanel?.etiqueta ?? null}
            colapsable
          />
        </div>
      </div>

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
            {confirmables === 1
              ? 'Vas a dar por bueno el valor propuesto de 1 consulta.'
              : `Vas a dar por buenos los valores propuestos de ${confirmables} consultas.`}{' '}
            Los datos entran a la documentación de la obra con tu usuario y el cómputo se rehace.
            {elegidas.length > confirmables
              ? ` Las otras ${elegidas.length - confirmables} de la selección no traen todo lo que la consulta pide: quedan abiertas para responderlas a mano.`
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
