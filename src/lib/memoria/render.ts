/**
 * La memoria de obra en markdown: el documento que el arquitecto baja, lee y
 * adjunta al expediente (§27 del prompt maestro).
 *
 * Responde, sin abrir la plataforma, las preguntas que un tercero le va a
 * hacer al cómputo: **qué documentación se miró**, **qué hechos valen para toda
 * la obra**, **qué elementos se leyeron y dónde**, **qué relaciones y
 * deducciones los sostienen**, **qué se contradice**, **qué falta** y —la que
 * más importa— **qué números no están escritos en ningún lado y salieron de
 * medir el dibujo**.
 *
 * ## Las 7 secciones están siempre
 *
 * Aunque no haya una sola fila. Una sección que desaparece cuando está vacía
 * se lee como "acá no había que mirar", y el documento existe justamente para
 * que el hueco se vea. Vacía dice `— nada registrado —` y se acabó.
 *
 * ## Por qué no importa `deduccion/memoria.ts`
 *
 * La memoria de deducciones (RF-505) es el otro documento del estudio y sus
 * títulos de regla son los mismos, pero traerlos de ahí arrastra
 * `deduccion/motor` —y con él las cinco reglas del §11— adentro del grafo de un
 * route que solo quiere imprimir texto. La duplicación es de siete strings y el
 * `Record<ReglaDeduccion, string>` la hace un error de compilación el día que
 * aparezca una regla nueva, que es exactamente la garantía que hacía falta.
 *
 * Números en es-AR (`2,6 m`, `80%`): el que lee esto es una persona, no un
 * modelo. La compacta (`compacta.ts`) hace lo contrario, y a propósito.
 *
 * Módulo puro: sin I/O, sin DB, sin red.
 */
import { ETIQUETA_UNIDAD, formatearNumero } from '@/lib/computo/unidades';
import {
  agruparPorLamina,
  refsDeFuentes,
  SIN_REGISTRO,
  type DeduccionDeMemoria,
  type EntradaMemoria,
  type HallazgoDeMemoria,
  type LaminaDeMemoria,
} from '@/lib/memoria/compacta';
import type {
  DatoObraResuelto,
  EstadoAnalisis,
  EstadoDeduccion,
  EstadoReforma,
  Origen,
  ReglaDeduccion,
  TipoEntidad,
  TipoHallazgo,
  TipoLamina,
  TipoObra,
} from '@/types/domain';
import type { EntidadPersistida } from '@/lib/computo/engine';

/** Las 7 del §27, en orden. El orden es el del razonamiento, no alfabético. */
export const SECCIONES_MD = [
  'Documentación analizada',
  'Datos de obra',
  'Elementos',
  'Relaciones y deducciones',
  'Conflictos',
  'Información faltante',
  'Datos inferidos',
] as const;

/** Celda vacía: se ve el hueco, no un espacio que parece un error de armado. */
const VACIO = '—';

/**
 * El descargo del PRD §12, con lo que este documento agrega: acá adentro hay
 * números que nadie escribió en una cota.
 */
const DESCARGO =
  '_La plataforma asiste: el cómputo, lo deducido y lo inferido los firma el profesional ' +
  'interviniente. Lo marcado como inferido salió de medir sobre el dibujo, no de una cota ' +
  'del proyecto: verificalo antes de comprar. Nada de índole estructural o de seguridad se ' +
  'deduce automáticamente (RF-506)._';

const ETIQUETA_TIPO_OBRA: Record<TipoObra, string> = {
  nueva: 'Obra nueva',
  reforma: 'Obra de reforma',
  ampliacion: 'Obra de ampliación',
};

const ETIQUETA_TIPO_LAMINA: Record<TipoLamina, string> = {
  planta: 'Planta',
  corte: 'Corte',
  vista: 'Vista',
  detalle: 'Detalle',
  planilla: 'Planilla',
  otra: 'Otra',
};

const ETIQUETA_ESTADO_ANALISIS: Record<EstadoAnalisis, string> = {
  pendiente: 'Pendiente',
  procesando: 'Procesando',
  analizada: 'Analizada',
  bloqueada_escala: 'Bloqueada por escala',
  error: 'Error',
};

const ETIQUETA_TIPO_ENTIDAD: Record<TipoEntidad, string> = {
  ambiente: 'Ambiente',
  muro: 'Muro',
  tabique: 'Tabique',
  abertura: 'Abertura',
  artefacto: 'Artefacto',
  terminacion: 'Terminación',
  cota: 'Cota',
  otro: 'Otro',
  tramo: 'Tramo',
  accesorio: 'Accesorio',
  boca: 'Boca',
};

const ETIQUETA_ESTADO_REFORMA: Record<EstadoReforma, string> = {
  existente: 'Existente',
  demoler: 'A demoler',
  nueva: 'Nueva',
  na: VACIO,
};

const ETIQUETA_ORIGEN: Record<Origen, string> = {
  explicito: 'Explícito',
  deducido: 'Deducido',
  supuesto: 'Supuesto',
  inferido: 'Inferido',
};

const ETIQUETA_TIPO_HALLAZGO: Record<TipoHallazgo, string> = {
  faltante: 'Faltante',
  inconsistencia: 'Inconsistencia',
  existente_confirmar: 'A confirmar',
  supuesto: 'Supuesto',
};

const ETIQUETA_ESTADO_DEDUCCION: Record<EstadoDeduccion, string> = {
  propuesta: 'Propuesta',
  validada: 'Validada',
  rechazada: 'Rechazada',
};

/** El nombre de cada regla en criollo (ver el comentario de cabecera). */
const ETIQUETA_REGLA: Record<ReglaDeduccion, string> = {
  planilla_plano: 'Planilla ↔ plano',
  planta_corte: 'Planta ↔ corte',
  continuidad: 'Continuidad entre láminas',
  idem_tipologia: 'Ídem tipología',
  cierre_cotas: 'Cierre de cotas',
  cruce: 'Cruce de información del expediente',
  medicion_grafica: 'Medición gráfica sobre el dibujo',
};

/** La memoria de obra completa, en markdown es-AR y sin dependencias. */
export function renderMemoriaMd(entrada: EntradaMemoria): string {
  const partes = [
    `# Memoria de obra — ${entrada.obra.nombre}`,
    encabezado(entrada),
    seccion('Documentación analizada', documentacion(entrada.laminas)),
    seccion('Datos de obra', datosDeObra(entrada)),
    seccion('Elementos', elementos(entrada)),
    seccion('Relaciones y deducciones', relaciones(entrada.deducciones)),
    seccion('Conflictos', conflictos(entrada.hallazgosAbiertos)),
    seccion('Información faltante', faltantes(entrada.hallazgosAbiertos)),
    seccion('Datos inferidos', inferidos(entrada)),
    '---',
    DESCARGO,
  ];
  return `${partes.join('\n\n')}\n`;
}

function seccion(titulo: (typeof SECCIONES_MD)[number], lineas: readonly string[]): string {
  return `## ${titulo}\n\n${lineas.length === 0 ? SIN_REGISTRO : lineas.join('\n')}`;
}

/**
 * "Obra de reforma · 3 láminas · 3 elementos · confianza promedio de lo leído:
 * 74%."
 *
 * El promedio es el de las confianzas de las entidades y de los datos de obra:
 * lo que el sistema **leyó**. Sin nada leído la frase no se escribe — un
 * promedio de cero mediciones sería un número inventado.
 */
function encabezado(entrada: EntradaMemoria): string {
  const confianzas = [
    ...entrada.entidades.map((entidad) => entidad.confianza),
    ...entrada.datosObra.map((dato) => dato.confianza),
  ];
  const partes = [
    ETIQUETA_TIPO_OBRA[entrada.obra.tipo],
    plural(entrada.laminas.length, 'lámina', 'láminas'),
    plural(entrada.entidades.length, 'elemento', 'elementos'),
  ];
  if (confianzas.length > 0) {
    const promedio = confianzas.reduce((suma, valor) => suma + valor, 0) / confianzas.length;
    partes.push(`confianza promedio de lo leído: ${porcentaje(promedio)}`);
  }
  return `${partes.join(' · ')}.`;
}

function documentacion(laminas: readonly LaminaDeMemoria[]): string[] {
  if (laminas.length === 0) return [];
  return tabla(
    ['Lámina', 'Título', 'Tipo', 'Escala', 'Estado'],
    laminas.map((lamina) => [
      lamina.codigo ?? lamina.id,
      lamina.titulo ?? VACIO,
      lamina.tipo === null ? VACIO : ETIQUETA_TIPO_LAMINA[lamina.tipo],
      escala(lamina),
      ETIQUETA_ESTADO_ANALISIS[lamina.estadoAnalisis],
    ]),
  );
}

/**
 * Una escala que nadie verificó **lo dice**: computar con la que el rótulo
 * declara es legítimo, hacerlo en silencio no (`src/app/CLAUDE.md` §6).
 */
function escala(lamina: LaminaDeMemoria): string {
  if (lamina.escala === null) return 'sin escala';
  return `${lamina.escala} (${lamina.escalaConfiable ? 'confirmada' : 'asumida'})`;
}

function datosDeObra(entrada: EntradaMemoria): string[] {
  if (entrada.datosObra.length === 0) return [];
  return tabla(
    ['Dato', 'Valor', 'Origen', 'Confianza', 'Fuentes', 'Método'],
    entrada.datosObra.map((dato) => [
      dato.clave,
      valorDeDato(dato),
      ETIQUETA_ORIGEN[dato.origen],
      porcentaje(dato.confianza),
      citar(dato, entrada),
      dato.metodo ?? VACIO,
    ]),
  );
}

function valorDeDato(dato: DatoObraResuelto): string {
  const valor = typeof dato.valor === 'number' ? formatearNumero(dato.valor) : dato.valor;
  return dato.unidad === undefined ? valor : `${valor} ${ETIQUETA_UNIDAD[dato.unidad]}`;
}

function citar(dato: DatoObraResuelto, entrada: EntradaMemoria): string {
  const refs = refsDeFuentes(dato.fuentes, entrada.laminas);
  return refs.length === 0 ? VACIO : refs.join(', ');
}

/** Los elementos leídos, lámina por lámina: dónde está cada cosa. */
function elementos(entrada: EntradaMemoria): string[] {
  return agruparPorLamina(entrada).flatMap((grupo) => [
    `### ${grupo.ref}`,
    '',
    ...tabla(
      ['Elemento', 'Tipo', 'Estado', 'Atributos'],
      grupo.entidades.map((entidad) => [
        entidad.nombre,
        ETIQUETA_TIPO_ENTIDAD[entidad.tipo],
        ETIQUETA_ESTADO_REFORMA[entidad.estadoReforma],
        atributos(entidad),
      ]),
    ),
    '',
  ]);
}

/** `largoM = 3; alturaM = 2,6` — lo que nadie leyó (`null`) no es un atributo. */
function atributos(entidad: EntidadPersistida): string {
  const pares = Object.entries(entidad.atributos)
    .filter(([, valor]) => valor !== null)
    .map(([clave, valor]) => `${clave} = ${typeof valor === 'number' ? formatearNumero(valor) : valor}`);
  return pares.length === 0 ? VACIO : pares.join('; ');
}

/**
 * Las relaciones documentales: qué campo salió de cruzar qué con qué.
 *
 * Van **todas**, con su estado: una propuesta todavía sin decidir es parte de
 * lo que el sistema entendió de la documentación, aunque no haya escrito nada.
 */
function relaciones(deducciones: readonly DeduccionDeMemoria[]): string[] {
  if (deducciones.length === 0) return [];
  return tabla(
    ['Elemento', 'Campo', 'Regla', 'Confianza', 'Estado', 'Lámina'],
    deducciones.map((deduccion) => [
      deduccion.entidadNombre,
      deduccion.campo,
      ETIQUETA_REGLA[deduccion.regla],
      porcentaje(deduccion.confianza),
      ETIQUETA_ESTADO_DEDUCCION[deduccion.estado],
      deduccion.laminaCodigo,
    ]),
  );
}

/** Lo que la documentación dice dos veces y distinto (§17). */
function conflictos(hallazgos: readonly HallazgoDeMemoria[]): string[] {
  const filas = hallazgos.filter((hallazgo) => hallazgo.tipo === 'inconsistencia');
  if (filas.length === 0) return [];
  return tabla(
    ['Consulta', 'Descripción', 'Bloquea'],
    filas.map((hallazgo) => [hallazgo.clave, hallazgo.descripcion, siNo(hallazgo.bloqueante)]),
  );
}

/** Todo lo demás que sigue abierto: lo que de verdad no está en la documentación. */
function faltantes(hallazgos: readonly HallazgoDeMemoria[]): string[] {
  const filas = hallazgos.filter((hallazgo) => hallazgo.tipo !== 'inconsistencia');
  if (filas.length === 0) return [];
  return tabla(
    ['Consulta', 'Tipo', 'Descripción', 'Bloquea'],
    filas.map((hallazgo) => [
      hallazgo.clave,
      ETIQUETA_TIPO_HALLAZGO[hallazgo.tipo],
      hallazgo.descripcion,
      siNo(hallazgo.bloqueante),
    ]),
  );
}

/**
 * Lo que no está escrito en ningún lado: datos de obra `inferido` y campos que
 * salieron de medir el dibujo (`medicion_grafica`).
 *
 * Es la sección que justifica el documento entero. Del campo medido no se
 * repite el valor —vive en la planilla, con su unidad y su desperdicio—: acá se
 * cita el hecho y **cómo** se llegó a él, que es lo que hay que verificar.
 */
function inferidos(entrada: EntradaMemoria): string[] {
  const deDatos = entrada.datosObra
    .filter((dato) => dato.origen === 'inferido')
    .map((dato) => [
      dato.clave,
      valorDeDato(dato),
      dato.metodo ?? ETIQUETA_REGLA.medicion_grafica,
      porcentaje(dato.confianza),
    ]);
  const deMedidas = entrada.deducciones
    .filter(
      (deduccion) => deduccion.regla === 'medicion_grafica' && deduccion.estado !== 'rechazada',
    )
    .map((deduccion) => [
      `${deduccion.entidadNombre} · ${deduccion.campo}`,
      VACIO,
      ETIQUETA_REGLA.medicion_grafica,
      porcentaje(deduccion.confianza),
    ]);

  const filas = [...deDatos, ...deMedidas];
  if (filas.length === 0) return [];
  return tabla(['Dato', 'Valor', 'Método', 'Confianza'], filas);
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

/** Encabezado + separador + filas, listo para pegar en el documento. */
function tabla(columnas: readonly string[], filas: readonly (readonly string[])[]): string[] {
  return [fila(columnas), fila(columnas.map(() => '---')), ...filas.map(fila)];
}

/** Una fila de markdown, con los pipes del contenido escapados. */
function fila(valores: readonly string[]): string {
  return `| ${valores.map((valor) => valor.replaceAll('|', '\\|')).join(' | ')} |`;
}

function porcentaje(confianza: number): string {
  return `${Math.round(confianza * 100)}%`;
}

function siNo(valor: boolean): string {
  return valor ? 'Sí' : 'No';
}

function plural(cantidad: number, singular: string, plural: string): string {
  return `${cantidad} ${cantidad === 1 ? singular : plural}`;
}
