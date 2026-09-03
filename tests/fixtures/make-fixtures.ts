/**
 * Generador de fixtures sintéticos: `npm run fixtures`.
 *
 * Escribe lo que los tests dan por existente (y que está commiteado, para que la
 * suite no dependa de regenerarlo):
 *
 *   tests/fixtures/pdfs/obra-demo.pdf        3 páginas A4 apaisado (planta, corte, planilla)
 *   tests/fixtures/pdfs/obra-reforma.pdf     2 páginas (planta de reforma, planilla)
 *   tests/fixtures/pdfs/sin-escala.pdf       1 página sin escala declarada
 *   tests/fixtures/pdfs/escala-declarada.pdf 1 página con escala declarada NO verificada
 *   tests/fixtures/pdfs/obra-busqueda.pdf    2 páginas (planta sin acotar + planilla vacía)
 *   tests/fixtures/pdfs/obra-fases.pdf       2 páginas (planta sin alturas + corte)
 *   tests/fixtures/pdfs/obra-conjunta.pdf    6 páginas (el expediente completo: golden 3)
 *   tests/fixtures/analysis/obra-demo-p1..p3.json      qué "ve" el provider mock
 *   tests/fixtures/analysis/obra-reforma-p1..p2.json   ídem, para el golden 2
 *   tests/fixtures/analysis/escala-declarada-p1.json   ídem, para la escala asumida
 *   tests/fixtures/analysis/obra-busqueda-p1..p2.json  ídem, para la búsqueda dirigida
 *   tests/fixtures/analysis/obra-fases-p1..p2.json     ídem, para el pipeline por fases
 *   tests/fixtures/analysis/obra-conjunta-p1..p6.json  ídem, para el golden 3
 *   tests/fixtures/analysis/busqueda/obra-busqueda-p2.json  qué "encuentra" la búsqueda
 *   tests/fixtures/analysis/busqueda/obra-fases-p2.json     ídem, la altura en el corte
 *   tests/fixtures/analysis/cruce/obra-fases.json      qué **relaciona** el cruce (por obra)
 *   tests/fixtures/analysis/cruce/obra-conjunta.json   ídem, los dos hechos de la obra del golden 3
 *
 * `sin-escala.pdf` NO tiene fixture de análisis a propósito: es el caso que
 * ejercita el bloqueo por escala del pipeline (RF-201).
 *
 * **Determinismo:** pdf-lib estampa fecha de creación/modificación al guardar, así
 * que las fijamos a una constante. Con eso dos corridas producen los mismos bytes
 * y `git status` queda limpio si nada cambió.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { zCruceFixture } from '@/lib/analysis/cruce-mock';
import { zAnalisisLamina, type AnalisisLamina } from '@/lib/analysis/tipos';
import type { BBox } from '@/types/domain';

// --- A4 apaisado, en puntos PostScript -------------------------------------
const ANCHO = 841.89;
const ALTO = 595.28;

/** Fecha fija: sin esto los bytes cambian en cada corrida. */
const FECHA_FIJA = new Date('2026-01-01T00:00:00.000Z');

const NEGRO = rgb(0, 0, 0);
const GRIS = rgb(0.45, 0.45, 0.45);
const GRIS_CLARO = rgb(0.85, 0.85, 0.85);

const DIR_PDFS = new URL('pdfs/', import.meta.url);
const DIR_ANALISIS = new URL('analysis/', import.meta.url);
/** Fixtures de la búsqueda dirigida: otra familia de providers, otra carpeta. */
const DIR_BUSQUEDA = new URL('analysis/busqueda/', import.meta.url);
/** Fixtures del cruce: la única familia cuya clave es la **obra**, no la lámina. */
const DIR_CRUCE = new URL('analysis/cruce/', import.meta.url);

// ---------------------------------------------------------------------------
// Qué ve el provider mock en cada página de obra-demo.pdf.
//
// Los números son el insumo del golden set (Tarea 10) y de los tests del
// pipeline: tabique T1 de 5 × 2,60 m a 2 caras ⇒ 26 m² de durlock; muro M1 de
// 6 × 2,60 m ⇒ 15,6 m² de mampostería; piso 20 m² vs cielorraso 19 m² del Estar
// ⇒ 5 % de diferencia, por debajo del 10 % que dispara el sanity check.
// ---------------------------------------------------------------------------

const P1: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANTA PB',
    codigo: 'A-01',
    disciplina: 'arquitectura',
    tipoLamina: 'planta',
    escala: '1:100',
    escalaConfiable: true,
    revision: '0',
    confianza: 0.95,
  },
  entidades: [
    {
      tipo: 'ambiente',
      nombre: 'Estar',
      bbox: [0.08, 0.2, 0.34, 0.45],
      confianza: 0.92,
      estadoReforma: 'na',
      atributos: { superficieM2: 20, perimetroM: 18, alturaM: 2.6, vanosM2: 4 },
    },
    {
      tipo: 'ambiente',
      nombre: 'Dormitorio',
      bbox: [0.44, 0.2, 0.24, 0.32],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { superficieM2: 12, perimetroM: 14, alturaM: 2.6, vanosM2: 2 },
    },
    {
      tipo: 'tabique',
      nombre: 'T1',
      bbox: [0.42, 0.2, 0.02, 0.45],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { tipo: 'durlock', largoM: 5, alturaM: 2.6, caras: 2 },
    },
    {
      tipo: 'muro',
      nombre: 'M1',
      bbox: [0.06, 0.18, 0.02, 0.49],
      confianza: 0.86,
      estadoReforma: 'na',
      atributos: { tipo: 'mamposteria', largoM: 6, alturaM: 2.6 },
    },
    {
      tipo: 'abertura',
      nombre: 'V1',
      bbox: [0.16, 0.18, 0.1, 0.02],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tag: 'V1', tipologia: 'ventana', anchoM: 1.5, altoM: 1.1 },
    },
    {
      tipo: 'abertura',
      nombre: 'P1',
      bbox: [0.2, 0.64, 0.06, 0.02],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.8, altoM: 2.05 },
    },
    {
      tipo: 'abertura',
      nombre: 'P2',
      bbox: [0.42, 0.34, 0.02, 0.06],
      confianza: 0.85,
      estadoReforma: 'na',
      atributos: { tag: 'P2', tipologia: 'puerta', anchoM: 0.8, altoM: 2.05 },
    },
  ],
};

const P2: AnalisisLamina = {
  rotulo: {
    titulo: 'CORTE A-A',
    codigo: 'A-02',
    disciplina: 'arquitectura',
    tipoLamina: 'corte',
    escala: '1:100',
    escalaConfiable: true,
    revision: '0',
    confianza: 0.93,
  },
  entidades: [
    {
      tipo: 'terminacion',
      nombre: 'Piso Estar',
      bbox: [0.1, 0.62, 0.34, 0.04],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { superficieM2: 20, ubicacion: 'piso', ambiente: 'Estar' },
    },
    {
      tipo: 'terminacion',
      nombre: 'Cielorraso Estar',
      bbox: [0.1, 0.26, 0.34, 0.04],
      confianza: 0.86,
      estadoReforma: 'na',
      atributos: { superficieM2: 19, ubicacion: 'cielorraso', ambiente: 'Estar' },
    },
    {
      tipo: 'terminacion',
      nombre: 'Piso Dormitorio',
      bbox: [0.48, 0.62, 0.24, 0.04],
      confianza: 0.85,
      estadoReforma: 'na',
      atributos: { superficieM2: 12, ubicacion: 'piso', ambiente: 'Dormitorio' },
    },
  ],
};

/** Una planilla de carpinterías no tiene escala y no aporta entidades geométricas. */
const P3: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANILLA DE CARPINTERÍAS',
    codigo: 'A-03',
    disciplina: 'arquitectura',
    tipoLamina: 'planilla',
    escala: null,
    // Una planilla no imprime escala y el prompt manda `escalaConfiable: true`
    // SOLO tras verificar contra ≥ 2 cotas: el provider real no puede devolver
    // otra cosa que `false` acá (tests/CLAUDE.md, regla 6).
    escalaConfiable: false,
    revision: '0',
    confianza: 0.9,
  },
  entidades: [],
};

interface Lamina {
  clave: string;
  /** Texto grande arriba a la izquierda. */
  encabezado: string;
  analisis: AnalisisLamina;
}

const LAMINAS: Lamina[] = [
  { clave: 'obra-demo-p1', encabezado: 'PLANTA PB — 1:100', analisis: P1 },
  { clave: 'obra-demo-p2', encabezado: 'CORTE A-A — 1:100', analisis: P2 },
  { clave: 'obra-demo-p3', encabezado: 'PLANILLA DE CARPINTERÍAS', analisis: P3 },
];

// ---------------------------------------------------------------------------
// obra-reforma.pdf — el segundo caso del golden set (tests/golden/obra-reforma)
//
// Ejercita tres cosas que `obra-demo` no toca, todas de F2/§11:
//
//   · un muro a demoler (M1, 4 × 2,60 m) ⇒ solo `gruesa.demolicion`;
//   · un tabique EXISTENTE (T9) que no computa nada, al lado de uno nuevo (T2);
//   · dos carpinterías a medio acotar en la planta y completas en la planilla
//     ⇒ deducciones `planilla_plano`: V5 (ventana) sin ancho ni alto —dos
//     propuestas— y P3 (puerta) sin el ancho —una—. Validadas, los ítems salen
//     con `origen: 'deducido'` y con la cantidad de la planta (una sola V5 y una
//     sola P3, no dos de cada una: la planilla especifica, no suma).
//
// Las tres propuestas son también lo que siembra `scripts/seed.ts`, que valida
// solo la de P3 y deja las dos de V5 esperando en la bandeja.
// ---------------------------------------------------------------------------

const R1: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANTA REFORMA',
    codigo: 'A-01',
    disciplina: 'arquitectura',
    tipoLamina: 'planta',
    escala: '1:50',
    escalaConfiable: true,
    revision: '1',
    confianza: 0.94,
  },
  entidades: [
    {
      tipo: 'muro',
      nombre: 'M1',
      bbox: [0.06, 0.18, 0.02, 0.4],
      confianza: 0.9,
      estadoReforma: 'demoler',
      atributos: { tipo: 'mamposteria', largoM: 4, alturaM: 2.6 },
    },
    {
      tipo: 'tabique',
      nombre: 'T9',
      bbox: [0.12, 0.62, 0.28, 0.02],
      confianza: 0.9,
      estadoReforma: 'existente',
      atributos: { tipo: 'durlock', largoM: 3, alturaM: 2.5, caras: 2 },
    },
    {
      tipo: 'tabique',
      nombre: 'T2',
      bbox: [0.44, 0.2, 0.02, 0.42],
      confianza: 0.9,
      estadoReforma: 'nueva',
      atributos: { tipo: 'durlock', largoM: 4, alturaM: 2.5, caras: 2 },
    },
    {
      // Sin `anchoM` ni `altoM`: en el plano la ventana no está acotada.
      tipo: 'abertura',
      nombre: 'V5',
      bbox: [0.18, 0.16, 0.1, 0.02],
      confianza: 0.9,
      estadoReforma: 'nueva',
      atributos: { tag: 'V5', tipologia: 'ventana' },
    },
    {
      // Media acotada: el alto está, el ancho no. Una sola deducción.
      tipo: 'abertura',
      nombre: 'P3',
      bbox: [0.3, 0.62, 0.06, 0.02],
      confianza: 0.9,
      estadoReforma: 'nueva',
      atributos: { tag: 'P3', tipologia: 'puerta', altoM: 2.05 },
    },
    {
      tipo: 'ambiente',
      nombre: 'Cocina',
      bbox: [0.12, 0.24, 0.28, 0.32],
      confianza: 0.92,
      estadoReforma: 'nueva',
      atributos: { superficieM2: 9, perimetroM: 12, alturaM: 2.5, vanosM2: 2 },
    },
  ],
};

const R2: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANILLA DE CARPINTERÍAS',
    codigo: 'A-05',
    disciplina: 'arquitectura',
    tipoLamina: 'planilla',
    escala: null,
    // Una planilla no imprime escala y el prompt manda `escalaConfiable: true`
    // SOLO tras verificar contra ≥ 2 cotas: el provider real no puede devolver
    // otra cosa que `false` acá (tests/CLAUDE.md, regla 6).
    escalaConfiable: false,
    revision: '1',
    confianza: 0.9,
  },
  entidades: [
    {
      // La misma V5, acá sí acotada. No es una segunda ventana.
      tipo: 'abertura',
      nombre: 'V5',
      bbox: [0.1, 0.3, 0.6, 0.1],
      confianza: 0.9,
      estadoReforma: 'nueva',
      atributos: { tag: 'V5', tipologia: 'ventana', anchoM: 1.2, altoM: 1 },
    },
    {
      // La misma P3, con las dos medidas: de acá sale el ancho que falta.
      tipo: 'abertura',
      nombre: 'P3',
      bbox: [0.1, 0.45, 0.6, 0.1],
      confianza: 0.9,
      estadoReforma: 'nueva',
      atributos: { tag: 'P3', tipologia: 'puerta', anchoM: 0.8, altoM: 2.05 },
    },
  ],
};

const LAMINAS_REFORMA: Lamina[] = [
  { clave: 'obra-reforma-p1', encabezado: 'PLANTA REFORMA — 1:50', analisis: R1 },
  { clave: 'obra-reforma-p2', encabezado: 'PLANILLA DE CARPINTERÍAS', analisis: R2 },
];

// ---------------------------------------------------------------------------
// escala-declarada.pdf — la lámina que declara escala pero no la verifica
//
// Es el único fixture con `escala: '1:20'` + `escalaConfiable: false`, y por eso
// es obligatorio: hasta acá ningún fixture ejercitaba ese caso, así que la
// tercera salida del bloqueo por escala ("escala asumida": se analiza igual, se
// computa, y queda un supuesto no bloqueante con la declarada como propuesta)
// nacía sin red de tests.
//
// El tabique T5 de 4 × 2,60 m a 2 caras da 20,80 m² netos ⇒ con 12% de
// desperdicio, 23,296 m² ⇒ 9 placas de 2,88 m² = **25,92 m²** de compra. Ese
// número es el pin: si la lámina se bloqueara, no habría ítem ninguno.
// ---------------------------------------------------------------------------

const E1: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANTA ALTA',
    codigo: 'A-04',
    disciplina: 'arquitectura',
    tipoLamina: 'planta',
    escala: '1:20',
    // Declarada en el rótulo, pero sin cota verificable que la respalde.
    escalaConfiable: false,
    revision: '0',
    confianza: 0.9,
  },
  entidades: [
    {
      tipo: 'tabique',
      nombre: 'T5',
      bbox: [0.3, 0.22, 0.02, 0.44],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tipo: 'durlock', largoM: 4, alturaM: 2.6, caras: 2 },
    },
  ],
};

const LAMINAS_ESCALA_DECLARADA: Lamina[] = [
  { clave: 'escala-declarada-p1', encabezado: 'PLANTA ALTA — 1:20', analisis: E1 },
];

// ---------------------------------------------------------------------------
// obra-busqueda.pdf — la obra donde el dato existe pero no está estructurado
//
// Reproduce el caso real que motivó "proponer en vez de bloquear": la puerta
// FP01 está dibujada en la planta **sin acotar**, y sus medidas están escritas
// en la planilla de carpinterías, que el análisis lee como lámina pero de la
// que **no** extrae entidades (`entidades: []`, tal como el prompt de F0 pedía).
//
// Con esto la deducción planilla↔plano no puede disparar —no hay una segunda
// entidad FP01 de dónde copiar— y el único camino al dato es la búsqueda
// dirigida sobre la lámina p2, cuyo fixture vive en `analysis/busqueda/`.
// ---------------------------------------------------------------------------

const B1: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANTA PB',
    codigo: 'A-01',
    disciplina: 'arquitectura',
    tipoLamina: 'planta',
    escala: '1:100',
    escalaConfiable: true,
    revision: '0',
    confianza: 0.9,
  },
  entidades: [
    {
      // Sin `anchoM` ni `altoM`: en la planta la puerta no está acotada.
      tipo: 'abertura',
      nombre: 'FP01',
      bbox: [0.24, 0.5, 0.06, 0.02],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tag: 'FP01', tipologia: 'puerta' },
    },
  ],
};

const B2: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANILLA DE CARPINTERÍAS',
    codigo: 'DET00',
    disciplina: 'arquitectura',
    tipoLamina: 'planilla',
    escala: null,
    // Una planilla no imprime escala y el prompt manda `escalaConfiable: true`
    // SOLO tras verificar contra ≥ 2 cotas: el provider real no puede devolver
    // otra cosa que `false` acá (tests/CLAUDE.md, regla 6).
    escalaConfiable: false,
    revision: '0',
    confianza: 0.9,
  },
  // Vacío a propósito: la planilla se analiza pero no aporta entidades.
  entidades: [],
};

const LAMINAS_BUSQUEDA: Lamina[] = [
  { clave: 'obra-busqueda-p1', encabezado: 'PLANTA PB — 1:100', analisis: B1 },
  { clave: 'obra-busqueda-p2', encabezado: 'PLANILLA DE CARPINTERÍAS — DET00', analisis: B2 },
];

// ---------------------------------------------------------------------------
// obra-fases.pdf — la obra que ejercita el pipeline por fases (§4)
//
// Dos láminas y tres caminos que ninguna otra obra de fixtures recorre:
//
//   · **el cruce**: T1 está dibujado en la planta sin altura, y la altura de
//     local está acotada en el corte. Ninguna regla determinista lo une —el
//     corte no dibuja un T1 del que copiar—, así que el único camino es el
//     cruce del expediente (`analysis/cruce/obra-fases.json`);
//   · **la medición gráfica**: M1 no tiene largo acotado en la planta y M2 no
//     tiene altura acotada en el corte. Los dos rectángulos sí están dibujados,
//     y las dos láminas declaran escala 1:50: sus medidas salen de medir el
//     dibujo, con origen `inferido`;
//   · **la relectura de un dato de obra**: T2 se queda sin altura después del
//     cruce, así que la consulta agrupada `dato_obra.altura_local.general` sigue
//     abierta y la búsqueda dirigida vuelve al corte a buscarla
//     (`analysis/busqueda/obra-fases-p2.json`).
//
// Los bboxes de M1 y M2 están elegidos para que la medición dé números
// redondos con la hoja A4 apaisada y la escala 1:50: M1 mide 7,43 m de largo y
// M2, 2,60 m de alto.
// ---------------------------------------------------------------------------

const F1: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANTA PB',
    codigo: 'A-01',
    disciplina: 'arquitectura',
    tipoLamina: 'planta',
    escala: '1:50',
    escalaConfiable: true,
    revision: '0',
    confianza: 0.94,
  },
  entidades: [
    {
      // Sin `alturaM`: la planta no acota la altura de los tabiques, la declara
      // el corte una vez para todo el local.
      tipo: 'tabique',
      nombre: 'T1',
      bbox: [0.2, 0.2, 0.02, 0.3],
      confianza: 0.9,
      estadoReforma: 'nueva',
      atributos: { tipo: 'durlock', largoM: 4, caras: 2 },
    },
    {
      tipo: 'tabique',
      nombre: 'T2',
      bbox: [0.5, 0.2, 0.02, 0.24],
      confianza: 0.9,
      estadoReforma: 'nueva',
      atributos: { tipo: 'durlock', largoM: 3, caras: 2 },
    },
    {
      // Sin `largoM`: el muro está dibujado y no acotado. En planta, el ancho
      // del rectángulo ES el largo del muro.
      tipo: 'muro',
      nombre: 'M1',
      bbox: [0.06, 0.8, 0.5, 0.02],
      confianza: 0.88,
      estadoReforma: 'nueva',
      atributos: { tipo: 'mamposteria', alturaM: 2.6 },
    },
  ],
};

const F2: AnalisisLamina = {
  rotulo: {
    titulo: 'CORTE A-A',
    codigo: 'A-02',
    disciplina: 'arquitectura',
    tipoLamina: 'corte',
    escala: '1:50',
    escalaConfiable: true,
    revision: '0',
    confianza: 0.93,
  },
  entidades: [
    {
      // Sin `alturaM`: en un corte, el alto del rectángulo ES la altura.
      tipo: 'muro',
      nombre: 'M2',
      bbox: [0.15, 0.3, 0.3, 0.2476],
      confianza: 0.87,
      estadoReforma: 'nueva',
      atributos: { tipo: 'mamposteria', largoM: 3 },
    },
  ],
};

const LAMINAS_FASES: Lamina[] = [
  { clave: 'obra-fases-p1', encabezado: 'PLANTA PB — 1:50', analisis: F1 },
  { clave: 'obra-fases-p2', encabezado: 'CORTE A-A — 1:50', analisis: F2 },
];

/**
 * Qué relaciona el cruce en el expediente de la obra Obra Fases.
 *
 * La clave del fixture es la obra —`slug(nombreObra)`— y no la lámina: el cruce
 * es **una** llamada por obra. Se escribe crudo, con los valores como texto y
 * las láminas por código de rótulo, que es lo único que el modelo conoce.
 *
 * Lo que declara, y por qué cada cosa:
 *
 *   · `nivel.PB` — un hecho de la obra por encima del umbral: se escribe en
 *     `datos_obra`;
 *   · `altura_revestimiento.general` a 0,50 — por debajo del umbral: NO se
 *     escribe, y queda contado en la auditoría del cruce;
 *   · el `alturaM` de T1 leído en el corte — un campo que una lámina completa
 *     de otra: nace como deducción `cruce` **validada** y el ítem de seco sale
 *     `deducido`, citando el corte;
 *   · una relectura del corte — la fase 4 lo lee primero.
 *
 * T2 queda deliberadamente afuera: sin su altura, la consulta agrupada
 * `dato_obra.altura_local.general` sigue abierta y hay algo que la búsqueda dirigida
 * tenga que ir a buscar.
 */
const CRUCE_OBRA_FASES = {
  datosObra: [
    {
      clave: 'nivel.PB',
      valor: '0,00',
      unidad: 'm',
      laminaCodigo: 'A-02',
      bbox: [0.62, 0.72, 0.12, 0.04],
      confianza: 0.9,
    },
    {
      clave: 'altura_revestimiento.general',
      valor: '2,10',
      unidad: 'm',
      laminaCodigo: 'A-02',
      confianza: 0.5,
    },
  ],
  completados: [
    {
      laminaCodigo: 'A-01',
      entidadNombre: 'T1',
      campo: 'alturaM',
      valor: '2,60',
      fuenteLaminaCodigo: 'A-02',
      bbox: [0.15, 0.3, 0.3, 0.25],
      confianza: 0.85,
    },
  ],
  identidades: [],
  conflictos: [],
  relecturas: [
    { laminaCodigo: 'A-02', queBuscar: 'la altura de local, acotada en el corte' },
  ],
};

/** Lo que la búsqueda dirigida encuentra en el corte cuando le piden la altura. */
const BUSQUEDA_OBRA_FASES_P2 = [
  {
    // `general` y no `PB`: el tabique no declara `nivel` —el prompt de
    // extracción no se lo pide— así que la consulta agrupada que la búsqueda
    // tiene que responder es la de la familia sin nivel. Si acá dijera `PB`,
    // `sanearBusqueda` lo descartaría por pedir una clave que la corrida no
    // abrió, y la propuesta no llegaría nunca a la bandeja.
    clave: 'dato_obra.altura_local.general',
    campo: 'valor',
    valor: '2,60',
    bbox: [0.15, 0.3, 0.3, 0.25],
    confianza: 0.8,
  },
];

// ---------------------------------------------------------------------------
// Qué encuentra la búsqueda dirigida cuando le preguntan por FP01 en DET00.
//
// Este fixture NO es un `AnalisisLamina`: es la otra familia de providers (T3),
// que recibe una lista de claves+campos a buscar y devuelve lo que encontró,
// con el bbox de dónde lo leyó. Se guarda en `analysis/busqueda/<clave>.json`
// para que no colisione con los fixtures de análisis de lámina, que viven un
// nivel arriba y se resuelven por nombre.
// ---------------------------------------------------------------------------

interface HallazgoBuscado {
  /** Clave del hallazgo que se estaba respondiendo. */
  clave: string;
  campo: string;
  valor: number;
  bbox: BBox;
  confianza: number;
}

const BUSQUEDA_OBRA_BUSQUEDA_P2: HallazgoBuscado[] = [
  {
    clave: 'aberturas.medidas_vano.FP01',
    campo: 'anchoM',
    valor: 0.9,
    bbox: [0.1, 0.3, 0.3, 0.04],
    confianza: 0.85,
  },
  {
    clave: 'aberturas.medidas_vano.FP01',
    campo: 'altoM',
    valor: 2.05,
    bbox: [0.1, 0.3, 0.3, 0.04],
    confianza: 0.85,
  },
];

// ---------------------------------------------------------------------------
// obra-conjunta.pdf — el expediente completo, que es el golden 3
//
// Es la obra que prueba de qué se trató la ola: **el expediente es un conjunto**.
// Seis láminas que por separado no alcanzan y juntas cierran el cómputo:
//
//   · **A-01, la planta**: cuatro tabiques y un muro **sin altura**, dos
//     ambientes **sin altura**, y dos carpinterías dibujadas y no acotadas. Con
//     la lógica vieja esta lámina abría cinco consultas de altura idénticas;
//   · **A-02, el corte**: la altura de local de PB, 2,60 m, acotada una sola vez
//     para todo el nivel. El cruce la lee y la escribe como **dato de obra**
//     `altura_local.PB`, y de ahí la toman los cinco elementos y los dos
//     ambientes por la cadena de respaldo: cero consultas de altura;
//   · **A-05, la planilla de carpinterías**: las medidas de V1 y P1, que la
//     planta no acota. La deducción planilla↔plano las baja sola;
//   · **IS-01, la sanitaria**: tramos de agua fría, caliente y cloacal, con sus
//     accesorios y un inodoro que tiene su desagüe en el mismo ambiente;
//   · **IE-01, la eléctrica**: dos tomas y tres bocas de luz;
//   · **A-06, el cuadro de locales**: los cielorrasos, que la planta no dice.
//
// El único número que NO está escrito en ninguna lámina es hasta dónde llega el
// revestimiento del baño: lo declara el cruce como
// `altura_revestimiento.general` = 2,10 m, otro hecho de la obra entera.
//
// Nada de esta obra pide un clic: `validarDeducciones` queda en `false` a
// propósito. Todo lo que se aplica se auto-valida por confianza (≥ 0,70), y lo
// que el golden mide es la obra tal como sale del pipeline.
// ---------------------------------------------------------------------------

const C1: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANTA PB',
    codigo: 'A-01',
    disciplina: 'arquitectura',
    tipoLamina: 'planta',
    escala: '1:50',
    escalaConfiable: true,
    revision: '0',
    confianza: 0.95,
  },
  entidades: [
    {
      // Sin `alturaM`: la altura de local la declara el corte, una vez.
      tipo: 'ambiente',
      nombre: 'Estar',
      bbox: [0.08, 0.2, 0.3, 0.4],
      confianza: 0.92,
      estadoReforma: 'na',
      atributos: {
        superficieM2: 20,
        perimetroM: 18,
        vanosM2: 4,
        nivel: 'PB',
        solado: 'porcelanato',
        zocalo: 'madera',
      },
    },
    {
      // El baño lleva revestimiento y no lleva zócalo: hasta qué altura llega
      // no está en ninguna lámina, lo declara el cruce para toda la obra.
      tipo: 'ambiente',
      nombre: 'Baño',
      bbox: [0.42, 0.2, 0.16, 0.22],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: {
        superficieM2: 6,
        perimetroM: 10,
        vanosM2: 2,
        nivel: 'PB',
        solado: 'porcelanato',
        revestimiento: 'cerámica',
      },
    },
    // Los cuatro tabiques del caso: mismo local, misma altura, ninguno acotado.
    // Todos con `largoM` escrito, así que la medición gráfica no tiene nada que
    // hacer acá — lo único que falta es la altura, y viene del corte.
    {
      tipo: 'tabique',
      nombre: 'T1',
      bbox: [0.38, 0.2, 0.015, 0.4],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tipo: 'durlock', largoM: 4, caras: 2 },
    },
    {
      tipo: 'tabique',
      nombre: 'T2',
      bbox: [0.42, 0.42, 0.16, 0.015],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tipo: 'durlock', largoM: 3, caras: 2 },
    },
    {
      tipo: 'tabique',
      nombre: 'T3',
      bbox: [0.62, 0.2, 0.015, 0.2],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { tipo: 'durlock', largoM: 2, caras: 2 },
    },
    {
      tipo: 'tabique',
      nombre: 'T4',
      bbox: [0.62, 0.44, 0.015, 0.24],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { tipo: 'durlock', largoM: 3, caras: 2 },
    },
    {
      // El muro de mampostería, también sin altura: la misma del local.
      tipo: 'muro',
      nombre: 'M1',
      bbox: [0.06, 0.18, 0.02, 0.44],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tipo: 'mamposteria', largoM: 6 },
    },
    {
      // Dibujada y no acotada: sus medidas están en la planilla A-05.
      tipo: 'abertura',
      nombre: 'V1',
      bbox: [0.16, 0.18, 0.1, 0.02],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tag: 'V1', tipologia: 'ventana' },
    },
    {
      tipo: 'abertura',
      nombre: 'P1',
      bbox: [0.2, 0.6, 0.06, 0.02],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tag: 'P1', tipologia: 'puerta' },
    },
  ],
};

const C2: AnalisisLamina = {
  rotulo: {
    titulo: 'CORTE A-A',
    codigo: 'A-02',
    disciplina: 'arquitectura',
    tipoLamina: 'corte',
    escala: '1:50',
    escalaConfiable: true,
    revision: '0',
    confianza: 0.93,
  },
  entidades: [
    {
      // La altura de local, acotada. Una cota `total` sin parciales no le da
      // nada que cerrar a `cierre_cotas`: está acá para que el corte diga lo
      // que dice, y el que la usa es el cruce.
      tipo: 'cota',
      nombre: 'H local PB',
      bbox: [0.62, 0.3, 0.04, 0.26],
      confianza: 0.92,
      estadoReforma: 'na',
      atributos: { valorM: 2.6, sobre: 'local PB', tramo: 'total' },
    },
  ],
};

const C3: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANILLA DE CARPINTERÍAS',
    codigo: 'A-05',
    disciplina: 'arquitectura',
    tipoLamina: 'planilla',
    escala: null,
    // Una planilla no imprime escala (tests/CLAUDE.md, regla 6).
    escalaConfiable: false,
    revision: '0',
    confianza: 0.9,
  },
  entidades: [
    {
      tipo: 'abertura',
      nombre: 'V1',
      bbox: [0.1, 0.3, 0.6, 0.08],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tag: 'V1', tipologia: 'ventana', anchoM: 1.2, altoM: 1 },
    },
    {
      tipo: 'abertura',
      nombre: 'P1',
      bbox: [0.1, 0.42, 0.6, 0.08],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tag: 'P1', tipologia: 'puerta', anchoM: 0.8, altoM: 2.05 },
    },
  ],
};

const C4: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANTA SANITARIA',
    codigo: 'IS-01',
    disciplina: 'instalaciones',
    tipoLamina: 'planta',
    escala: '1:50',
    escalaConfiable: true,
    revision: '0',
    confianza: 0.9,
  },
  entidades: [
    // Agua caliente: tres tramos del mismo diámetro escrito de tres maneras
    // (el corralón los cotiza como uno solo).
    {
      tipo: 'tramo',
      nombre: 'TR1',
      bbox: [0.1, 0.24, 0.18, 0.012],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { sistema: 'ac', diametro: '20', longitudM: 2, ambiente: 'Baño' },
    },
    {
      tipo: 'tramo',
      nombre: 'TR2',
      bbox: [0.1, 0.3, 0.26, 0.012],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { sistema: 'ac', diametro: 'Ø20', longitudM: 3, ambiente: 'Baño' },
    },
    {
      tipo: 'tramo',
      nombre: 'TR3',
      bbox: [0.1, 0.36, 0.14, 0.012],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { sistema: 'ac', diametro: '20mm', longitudM: 1.5, ambiente: 'Baño' },
    },
    {
      tipo: 'tramo',
      nombre: 'TR4',
      bbox: [0.1, 0.42, 0.32, 0.012],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { sistema: 'af', diametro: '20', longitudM: 4, ambiente: 'Baño' },
    },
    {
      // El desagüe del baño: sin él, el inodoro abriría la inconsistencia de
      // correspondencia del §22.
      tipo: 'tramo',
      nombre: 'TR5',
      bbox: [0.1, 0.5, 0.44, 0.016],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { sistema: 'cloacal', diametro: 'Ø110', longitudM: 6, ambiente: 'Baño' },
    },
    {
      tipo: 'accesorio',
      nombre: 'A1',
      bbox: [0.28, 0.236, 0.016, 0.02],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { tipo: 'codo90', sistema: 'ac', diametro: '20' },
    },
    {
      tipo: 'accesorio',
      nombre: 'A2',
      bbox: [0.36, 0.296, 0.016, 0.02],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { tipo: 'codo90', sistema: 'ac', diametro: '20' },
    },
    {
      tipo: 'accesorio',
      nombre: 'A3',
      bbox: [0.24, 0.356, 0.016, 0.02],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { tipo: 'codo90', sistema: 'ac', diametro: 'Ø20' },
    },
    {
      tipo: 'accesorio',
      nombre: 'A4',
      bbox: [0.18, 0.296, 0.016, 0.02],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { tipo: 'te', sistema: 'ac', diametro: '20' },
    },
    {
      tipo: 'artefacto',
      nombre: 'Inodoro',
      bbox: [0.56, 0.48, 0.06, 0.06],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tipo: 'inodoro', ambiente: 'Baño' },
    },
  ],
};

const C5: AnalisisLamina = {
  rotulo: {
    titulo: 'PLANTA ELÉCTRICA',
    codigo: 'IE-01',
    disciplina: 'instalaciones',
    tipoLamina: 'planta',
    escala: '1:50',
    escalaConfiable: true,
    revision: '0',
    confianza: 0.9,
  },
  entidades: [
    {
      tipo: 'boca',
      nombre: 'B1',
      bbox: [0.12, 0.26, 0.02, 0.02],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tipo: 'toma', circuito: 'TUG1' },
    },
    {
      tipo: 'boca',
      nombre: 'B2',
      bbox: [0.2, 0.26, 0.02, 0.02],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tipo: 'toma', circuito: 'TUG1' },
    },
    {
      tipo: 'boca',
      nombre: 'B3',
      bbox: [0.28, 0.26, 0.02, 0.02],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tipo: 'luz', circuito: 'IUG1' },
    },
    {
      tipo: 'boca',
      nombre: 'B4',
      bbox: [0.36, 0.26, 0.02, 0.02],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { tipo: 'luz', circuito: 'IUG1' },
    },
    {
      tipo: 'boca',
      nombre: 'B5',
      bbox: [0.44, 0.26, 0.02, 0.02],
      confianza: 0.88,
      estadoReforma: 'na',
      atributos: { tipo: 'luz', circuito: 'IUG2' },
    },
  ],
};

const C6: AnalisisLamina = {
  rotulo: {
    titulo: 'CUADRO DE LOCALES',
    codigo: 'A-06',
    disciplina: 'arquitectura',
    tipoLamina: 'planilla',
    escala: null,
    escalaConfiable: false,
    revision: '0',
    confianza: 0.9,
  },
  entidades: [
    {
      // El cuadro de locales trae la terminación con sus m² ya resueltos: no
      // necesita ni perímetro ni altura.
      tipo: 'terminacion',
      nombre: 'Cielorraso Estar',
      bbox: [0.1, 0.3, 0.6, 0.08],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { ubicacion: 'cielorraso', material: 'yeso', superficieM2: 20, ambiente: 'Estar' },
    },
    {
      tipo: 'terminacion',
      nombre: 'Cielorraso Baño',
      bbox: [0.1, 0.42, 0.6, 0.08],
      confianza: 0.9,
      estadoReforma: 'na',
      atributos: { ubicacion: 'cielorraso', material: 'yeso', superficieM2: 6, ambiente: 'Baño' },
    },
  ],
};

const LAMINAS_CONJUNTA: Lamina[] = [
  { clave: 'obra-conjunta-p1', encabezado: 'PLANTA PB — 1:50', analisis: C1 },
  { clave: 'obra-conjunta-p2', encabezado: 'CORTE A-A — 1:50', analisis: C2 },
  { clave: 'obra-conjunta-p3', encabezado: 'PLANILLA DE CARPINTERÍAS', analisis: C3 },
  { clave: 'obra-conjunta-p4', encabezado: 'PLANTA SANITARIA — 1:50', analisis: C4 },
  { clave: 'obra-conjunta-p5', encabezado: 'PLANTA ELECTRICA — 1:50', analisis: C5 },
  { clave: 'obra-conjunta-p6', encabezado: 'CUADRO DE LOCALES', analisis: C6 },
];

/**
 * Qué relaciona el cruce en el expediente de la obra Obra Conjunta.
 *
 * Dos hechos que valen para **toda la obra** y que ninguna entidad lleva
 * escritos encima:
 *
 *   · `altura_local.PB` = 2,60 m, leída en el corte A-02. Es el corazón del
 *     golden: los cuatro tabiques, el muro y los dos ambientes la toman por la
 *     cadena de respaldo, sus ítems salen `deducido` citando el corte, y la
 *     consulta agrupada `dato_obra.altura_local.PB` **no existe**;
 *   · `altura_revestimiento.general` = 2,10 m, leída en el cuadro de locales,
 *     que es lo que le falta al revestimiento del baño para tener m².
 *
 * Las dos por encima del umbral de 0,70: se escriben en `datos_obra` y se
 * aplican en la misma corrida. `completados` queda vacío a propósito — lo que
 * este caso prueba no es completar un campo de una entidad, sino que **un hecho
 * del expediente alcanza para todas las que lo esperan**.
 */
const CRUCE_OBRA_CONJUNTA = {
  datosObra: [
    {
      clave: 'altura_local.PB',
      valor: '2,60',
      unidad: 'm',
      laminaCodigo: 'A-02',
      bbox: [0.62, 0.3, 0.04, 0.26],
      confianza: 0.9,
    },
    {
      clave: 'altura_revestimiento.general',
      valor: '2,10',
      unidad: 'm',
      laminaCodigo: 'A-06',
      bbox: [0.1, 0.54, 0.6, 0.06],
      confianza: 0.85,
    },
  ],
  completados: [],
  identidades: [],
  conflictos: [],
  relecturas: [],
};

// ---------------------------------------------------------------------------
// Dibujo
// ---------------------------------------------------------------------------

/** bbox normalizado (origen arriba-izquierda) → rectángulo de pdf-lib (origen abajo-izquierda). */
function aRectangulo(bbox: BBox): { x: number; y: number; width: number; height: number } {
  const [x, y, ancho, alto] = bbox;
  return {
    x: x * ANCHO,
    y: ALTO - (y + alto) * ALTO,
    width: ancho * ANCHO,
    height: alto * ALTO,
  };
}

function dibujarLamina(pagina: PDFPage, font: PDFFont, lamina: Lamina): void {
  pagina.drawText(lamina.encabezado, { x: 42, y: ALTO - 66, size: 26, font, color: NEGRO });

  // Un rectángulo por entidad, en el bbox que declara el fixture: así el visor
  // (Tarea 7) puede superponer el overlay y coincidir con el dibujo.
  for (const entidad of lamina.analisis.entidades) {
    const caja = aRectangulo(entidad.bbox);
    pagina.drawRectangle({ ...caja, borderWidth: 1.5, borderColor: NEGRO });
    pagina.drawText(entidad.nombre, {
      x: caja.x + 4,
      y: caja.y + caja.height - 13,
      size: 9,
      font,
      color: GRIS,
    });
  }

  if (lamina.analisis.entidades.length === 0) {
    // La planilla no tiene geometría: una grilla vacía alcanza para que la
    // página no sea un rectángulo en blanco.
    for (let fila = 0; fila < 5; fila++) {
      pagina.drawRectangle({
        x: 60,
        y: ALTO - 160 - fila * 34,
        width: ANCHO - 120,
        height: 30,
        borderWidth: 1,
        borderColor: GRIS_CLARO,
      });
    }
  }

  dibujarRotulo(pagina, font, lamina.analisis);
}

/** Carátula abajo a la derecha, con los datos que el fixture dice que se leen. */
function dibujarRotulo(pagina: PDFPage, font: PDFFont, analisis: AnalisisLamina): void {
  const { rotulo } = analisis;
  const ancho = 240;
  const alto = 76;
  const x = ANCHO - ancho - 42;
  const y = 42;
  pagina.drawRectangle({ x, y, width: ancho, height: alto, borderWidth: 1, borderColor: NEGRO });

  const lineas = [
    rotulo.titulo ?? 'SIN TÍTULO',
    `Código: ${rotulo.codigo ?? '—'}   Rev. ${rotulo.revision ?? '—'}`,
    `Escala: ${rotulo.escala ?? 'sin escala'}`,
  ];
  lineas.forEach((linea, i) => {
    pagina.drawText(linea, { x: x + 10, y: y + alto - 20 - i * 16, size: 10, font, color: NEGRO });
  });
}

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------

async function nuevoDocumento(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.setTitle('Compulsa — fixture de tests');
  doc.setAuthor('make-fixtures.ts');
  doc.setProducer('compulsa/tests/fixtures/make-fixtures.ts');
  doc.setCreator('compulsa');
  doc.setCreationDate(FECHA_FIJA);
  doc.setModificationDate(FECHA_FIJA);
  return doc;
}

/** Un PDF con una página por lámina, en orden. */
async function documentoDe(laminas: readonly Lamina[]): Promise<Uint8Array> {
  const doc = await nuevoDocumento();
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  for (const lamina of laminas) {
    dibujarLamina(doc.addPage([ANCHO, ALTO]), font, lamina);
  }
  return doc.save();
}

async function sinEscala(): Promise<Uint8Array> {
  const doc = await nuevoDocumento();
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const pagina = doc.addPage([ANCHO, ALTO]);
  pagina.drawText('DETALLE CONSTRUCTIVO', { x: 42, y: ALTO - 66, size: 26, font, color: NEGRO });
  pagina.drawText('Lámina sin escala declarada ni cotas verificables.', {
    x: 42,
    y: ALTO - 96,
    size: 12,
    font,
    color: GRIS,
  });
  pagina.drawRectangle({
    x: 0.1 * ANCHO,
    y: 0.25 * ALTO,
    width: 0.5 * ANCHO,
    height: 0.4 * ALTO,
    borderWidth: 1.5,
    borderColor: NEGRO,
  });
  dibujarRotulo(pagina, font, {
    rotulo: {
      titulo: 'DETALLE CONSTRUCTIVO',
      codigo: 'D-01',
      disciplina: null,
      tipoLamina: null,
      escala: null,
      escalaConfiable: false,
      revision: null,
      confianza: 0,
    },
    entidades: [],
  });
  return doc.save();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(DIR_PDFS, { recursive: true });
  mkdirSync(DIR_ANALISIS, { recursive: true });
  mkdirSync(DIR_BUSQUEDA, { recursive: true });
  mkdirSync(DIR_CRUCE, { recursive: true });

  const escritos: string[] = [];

  const pdfs: Array<[string, Uint8Array]> = [
    ['obra-demo.pdf', await documentoDe(LAMINAS)],
    ['obra-reforma.pdf', await documentoDe(LAMINAS_REFORMA)],
    ['sin-escala.pdf', await sinEscala()],
    ['escala-declarada.pdf', await documentoDe(LAMINAS_ESCALA_DECLARADA)],
    ['obra-busqueda.pdf', await documentoDe(LAMINAS_BUSQUEDA)],
    ['obra-fases.pdf', await documentoDe(LAMINAS_FASES)],
    ['obra-conjunta.pdf', await documentoDe(LAMINAS_CONJUNTA)],
  ];
  for (const [nombre, bytes] of pdfs) {
    const destino = new URL(nombre, DIR_PDFS);
    writeFileSync(destino, bytes);
    escritos.push(`${fileURLToPath(destino)} (${bytes.length} bytes)`);
  }

  const todas = [
    ...LAMINAS,
    ...LAMINAS_REFORMA,
    ...LAMINAS_ESCALA_DECLARADA,
    ...LAMINAS_BUSQUEDA,
    ...LAMINAS_FASES,
    ...LAMINAS_CONJUNTA,
  ];
  for (const lamina of todas) {
    // Los fixtures son el contrato de los tests: si no validan, no se escriben.
    const analisis = zAnalisisLamina.parse(lamina.analisis);
    const destino = new URL(`${lamina.clave}.json`, DIR_ANALISIS);
    writeFileSync(destino, `${JSON.stringify(analisis, null, 2)}\n`, 'utf8');
    escritos.push(`${fileURLToPath(destino)} (${analisis.entidades.length} entidades)`);
  }

  const busquedas: Array<[string, unknown[]]> = [
    ['obra-busqueda-p2.json', BUSQUEDA_OBRA_BUSQUEDA_P2],
    ['obra-fases-p2.json', BUSQUEDA_OBRA_FASES_P2],
  ];
  for (const [nombre, datos] of busquedas) {
    const destino = new URL(nombre, DIR_BUSQUEDA);
    writeFileSync(destino, `${JSON.stringify(datos, null, 2)}\n`, 'utf8');
    escritos.push(`${fileURLToPath(destino)} (${datos.length} hallazgos)`);
  }

  // Los fixtures del cruce se validan contra el contrato del mock antes de
  // escribirse, igual que los de análisis: un fixture que el provider no podría
  // aceptar es un test que prueba otra cosa.
  const cruces: Array<[string, unknown]> = [
    ['obra-fases.json', CRUCE_OBRA_FASES],
    ['obra-conjunta.json', CRUCE_OBRA_CONJUNTA],
  ];
  for (const [nombre, datos] of cruces) {
    const destino = new URL(nombre, DIR_CRUCE);
    const validado = zCruceFixture.parse(datos);
    writeFileSync(destino, `${JSON.stringify(datos, null, 2)}\n`, 'utf8');
    escritos.push(
      `${fileURLToPath(destino)} (${validado.completados.length} completados, ` +
        `${validado.datosObra.length} datos de obra)`,
    );
  }

  console.log('Fixtures generados:');
  for (const linea of escritos) console.log(`  ${linea}`);
}

await main();
