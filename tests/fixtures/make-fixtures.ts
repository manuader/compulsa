/**
 * Generador de fixtures sintéticos: `npm run fixtures`.
 *
 * Escribe lo que los tests dan por existente (y que está commiteado, para que la
 * suite no dependa de regenerarlo):
 *
 *   tests/fixtures/pdfs/obra-demo.pdf     3 páginas A4 apaisado (planta, corte, planilla)
 *   tests/fixtures/pdfs/obra-reforma.pdf  2 páginas (planta de reforma, planilla)
 *   tests/fixtures/pdfs/sin-escala.pdf    1 página sin escala declarada
 *   tests/fixtures/analysis/obra-demo-p1..p3.json     qué "ve" el provider mock
 *   tests/fixtures/analysis/obra-reforma-p1..p2.json  ídem, para el golden 2
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
    escalaConfiable: true,
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
//   · una ventana (V5) dibujada en la planta SIN medidas y listada en la
//     planilla CON medidas ⇒ deducción `planilla_plano`. Validada, el ítem sale
//     con `origen: 'deducido'` y con la cantidad de la planta (una sola V5, no
//     dos: la planilla especifica, no suma).
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
    escalaConfiable: true,
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
  ],
};

const LAMINAS_REFORMA: Lamina[] = [
  { clave: 'obra-reforma-p1', encabezado: 'PLANTA REFORMA — 1:50', analisis: R1 },
  { clave: 'obra-reforma-p2', encabezado: 'PLANILLA DE CARPINTERÍAS', analisis: R2 },
];

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

  const escritos: string[] = [];

  const pdfs: Array<[string, Uint8Array]> = [
    ['obra-demo.pdf', await documentoDe(LAMINAS)],
    ['obra-reforma.pdf', await documentoDe(LAMINAS_REFORMA)],
    ['sin-escala.pdf', await sinEscala()],
  ];
  for (const [nombre, bytes] of pdfs) {
    const destino = new URL(nombre, DIR_PDFS);
    writeFileSync(destino, bytes);
    escritos.push(`${fileURLToPath(destino)} (${bytes.length} bytes)`);
  }

  for (const lamina of [...LAMINAS, ...LAMINAS_REFORMA]) {
    // Los fixtures son el contrato de los tests: si no validan, no se escriben.
    const analisis = zAnalisisLamina.parse(lamina.analisis);
    const destino = new URL(`${lamina.clave}.json`, DIR_ANALISIS);
    writeFileSync(destino, `${JSON.stringify(analisis, null, 2)}\n`, 'utf8');
    escritos.push(`${fileURLToPath(destino)} (${analisis.entidades.length} entidades)`);
  }

  console.log('Fixtures generados:');
  for (const linea of escritos) console.log(`  ${linea}`);
}

await main();
