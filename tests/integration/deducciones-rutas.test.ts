/**
 * Las dos descargas de la deducción, contra PGlite:
 *
 *   GET /api/obras/[obraId]/deducciones/memoria   → memoria de deducciones (RF-505)
 *   GET /api/obras/[obraId]/planilla-carpinterias → planilla derivada (RF-504)
 *
 * `tests/unit/deduccion-memoria.test.ts` ya prueba el markdown que arma
 * `generarMemoria()`. Lo que se prueba acá es lo que el generador no puede
 * saber: que los handlers **validen por su cuenta** —el `matcher` del
 * middleware excluye `/api/*`, así que sin este chequeo la memoria de una obra
 * ajena se baja con una URL adivinada (RNF-4)—, qué filas entran a cada archivo
 * y con qué origen, y que la descarga salga con los headers que el navegador
 * necesita.
 *
 * `next/headers` va mockeado: `getSession()` lee la cookie de ahí y en un test
 * no hay request de Next. La cookie se controla con `cookieActual`.
 */
import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { GET as GET_MEMORIA } from '@/app/api/obras/[obraId]/deducciones/memoria/route';
import { GET as GET_PLANILLA } from '@/app/api/obras/[obraId]/planilla-carpinterias/route';
import { setDbForTests, type Db } from '@/db/client';
import { deducciones, documentos, entidades, estudios, laminas, obras, usuarios } from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import {
  AVISO_DERIVADA,
  COLUMNAS_CARPINTERIA,
  NOMBRE_HOJA_PLANILLA,
} from '@/lib/export/planilla-carpinterias';
import type { BBox } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

/** Cookie que ve el handler en la llamada que viene. `undefined` ⇒ sin sesión. */
let cookieActual: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      cookieActual && nombre === 'compulsa_session' ? { value: cookieActual } : undefined,
  }),
}));

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BBOX: BBox = [0.1, 0.2, 0.05, 0.08];

let db: Db;
let obraId: string;
let obraAjenaId: string;
let token: string;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Ader' }).returning();
  const [estudioAjeno] = await db.insert(estudios).values({ nombre: 'Otro estudio' }).returning();

  const [usuario] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'manu@estudioader.ar',
      nombre: 'Manu Ader',
      passwordHash: 'no-se-usa',
      rol: 'titular',
    })
    .returning();

  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa Pérez', zona: 'CABA', tipo: 'reforma' })
    .returning();
  const [obraAjena] = await db
    .insert(obras)
    .values({ estudioId: estudioAjeno.id, nombre: 'Ajena', zona: 'GBA', tipo: 'nueva' })
    .returning();
  obraId = obra.id;
  obraAjenaId = obraAjena.id;

  const [doc] = await db
    .insert(documentos)
    .values({
      obraId: obra.id,
      nombreArchivo: 'casa-perez.pdf',
      tipo: 'plano',
      archivoRef: 'ref',
      mime: 'application/pdf',
      hash: 'hash',
      subidoPor: usuario.id,
    })
    .returning();

  const [planta] = await db
    .insert(laminas)
    .values({
      documentoId: doc.id,
      obraId: obra.id,
      numeroPagina: 1,
      codigo: 'A-01',
      titulo: 'Planta baja',
      tipo: 'planta',
      archivoRef: 'ref-p1',
      estadoAnalisis: 'analizada',
    })
    .returning();
  const [planilla] = await db
    .insert(laminas)
    .values({
      documentoId: doc.id,
      obraId: obra.id,
      numeroPagina: 2,
      codigo: 'A-05',
      titulo: 'Planilla de carpinterías',
      tipo: 'planilla',
      archivoRef: 'ref-p2',
      estadoAnalisis: 'analizada',
    })
    .returning();

  const abertura = (laminaId: string, nombre: string, atributos: Record<string, string | number>) =>
    db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId,
        tipo: 'abertura' as const,
        nombre,
        atributosJson: atributos,
        estadoReforma: 'na' as const,
        fuentesJson: [{ laminaId, bbox: BBOX, detalle: nombre }],
        confianza: 0.9,
      })
      .returning()
      .then((filas) => filas[0]!);

  // V1: acotada en la planilla del proyecto ⇒ explícita.
  await abertura(planilla.id, 'V1', {
    tag: 'V1',
    tipologia: 'ventana',
    anchoM: 1.2,
    altoM: 1,
    material: 'aluminio',
    vidrio: 'DVH',
  });
  // V2: sin acotar en la planta; las medidas las escribió una deducción validada.
  const v2 = await abertura(planta.id, 'V2', {
    tag: 'V2',
    tipologia: 'ventana',
    anchoM: 1.5,
    altoM: 1.1,
    material: 'aluminio',
  });
  // P1: sin medidas. Una deducción propuesta (no entra a ningún archivo) y una
  // rechazada (entra a la memoria, no a la planilla).
  const p1 = await abertura(planta.id, 'P1', { tag: 'P1', tipologia: 'puerta' });

  const fuentesCruzadas = [
    { laminaId: planta.id, bbox: BBOX, detalle: 'V2' },
    { laminaId: planilla.id, bbox: BBOX, detalle: 'V2' },
  ];

  await db.insert(deducciones).values([
    {
      obraId: obra.id,
      entidadId: v2.id,
      campo: 'anchoM',
      regla: 'planilla_plano',
      fuentesJson: fuentesCruzadas,
      valorJson: { anchoM: 1.5 },
      confianza: 0.76,
      estado: 'validada',
      validadoPor: usuario.id,
    },
    {
      obraId: obra.id,
      entidadId: v2.id,
      campo: 'altoM',
      regla: 'planilla_plano',
      fuentesJson: fuentesCruzadas,
      valorJson: { altoM: 1.1 },
      confianza: 0.76,
      estado: 'validada',
      validadoPor: usuario.id,
    },
    {
      obraId: obra.id,
      entidadId: p1.id,
      campo: 'anchoM',
      regla: 'idem_tipologia',
      fuentesJson: [{ laminaId: planta.id, bbox: BBOX, detalle: 'P1' }],
      valorJson: { anchoM: 0.9 },
      confianza: 0.72,
      estado: 'propuesta',
    },
    {
      obraId: obra.id,
      entidadId: p1.id,
      campo: 'altoM',
      regla: 'idem_tipologia',
      fuentesJson: [{ laminaId: planta.id, bbox: BBOX, detalle: 'P1' }],
      valorJson: { altoM: 2.05 },
      confianza: 0.72,
      estado: 'rechazada',
      validadoPor: usuario.id,
    },
  ]);

  token = (await crearSesion(db, usuario.id)).token;
});

function pedirMemoria(id = obraId): Promise<Response> {
  return GET_MEMORIA(new Request(`http://localhost/api/obras/${id}/deducciones/memoria`), {
    params: Promise.resolve({ obraId: id }),
  });
}

function pedirPlanilla(id = obraId): Promise<Response> {
  return GET_PLANILLA(new Request(`http://localhost/api/obras/${id}/planilla-carpinterias`), {
    params: Promise.resolve({ obraId: id }),
  });
}

// ---------------------------------------------------------------------------

describe('GET /api/obras/[obraId]/deducciones/memoria', () => {
  it('sin sesión responde 401 y no manda una línea del documento', async () => {
    cookieActual = undefined;
    const res = await pedirMemoria();
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('con una obra de otro estudio responde 404 (RNF-4)', async () => {
    cookieActual = token;
    expect((await pedirMemoria(obraAjenaId)).status).toBe(404);
    expect((await pedirMemoria('no-es-un-uuid')).status).toBe(404);
  });

  it('baja un .md con las decididas, sus firmas y sus láminas', async () => {
    cookieActual = token;
    const res = await pedirMemoria();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="memoria-deducciones-casa-perez-\d{4}-\d{2}-\d{2}\.md"$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');

    const texto = await res.text();

    // Dos validadas y una rechazada; la propuesta no es historia todavía.
    expect(texto).toContain('# Memoria de deducciones');
    expect(texto).toContain('3 deducciones: 2 validadas, 1 rechazada, 0 pendientes de validación.');
    expect(texto).toContain('## Planilla ↔ plano');
    expect(texto).toContain('## Ídem tipología');
    expect(texto).toContain('Manu Ader');
    // Las fuentes se citan por código de lámina, no por uuid.
    expect(texto).toContain('A-01, A-05');
    // El descargo profesional (§12) viaja siempre.
    expect(texto).toContain('los firma el profesional interviniente');
    // Y el valor de la propuesta no aparece por ningún lado.
    expect(texto).not.toContain('0,90 m');
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/obras/[obraId]/planilla-carpinterias', () => {
  it('sin sesión responde 401 y con obra ajena 404 (RNF-4)', async () => {
    cookieActual = undefined;
    expect((await pedirPlanilla()).status).toBe(401);

    cookieActual = token;
    expect((await pedirPlanilla(obraAjenaId)).status).toBe(404);
  });

  it('baja un XLSX que dice que es documentación derivada', async () => {
    cookieActual = token;
    const res = await pedirPlanilla();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(MIME_XLSX);
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="planilla-carpinterias-casa-perez-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer);
    const hoja = wb.getWorksheet(NOMBRE_HOJA_PLANILLA)!;

    // El aviso va en A1: es lo primero que se ve, y sobrevive a imprimir la hoja.
    expect(hoja.getCell('A1').value).toBe(AVISO_DERIVADA);
    expect(String(hoja.getCell('A2').value)).toContain('sujeto a validación del profesional');
    expect(hoja.getRow(5).values).toEqual([undefined, ...COLUMNAS_CARPINTERIA]);

    // Tres filas: primero las resueltas por tag, la pendiente al final.
    const filas = [6, 7, 8].map((n) => hoja.getRow(n).values as unknown[]);
    expect(filas.map((fila) => fila[1])).toEqual(['V1', 'V2', 'P1']);
    expect(filas.map((fila) => fila[7])).toEqual([
      'Explícito',
      'Deducido validado',
      'Pendiente',
    ]);

    // V2 lleva las medidas que validó una persona, y cita las dos láminas.
    expect(filas[1]![3]).toBe(1.5);
    expect(filas[1]![4]).toBe(1.1);
    expect(filas[1]![8]).toBe('A-01, A-05');

    // P1 no lleva ni un número: su deducción está propuesta, no validada (P4).
    expect(filas[2]![3]).toBeUndefined();
    expect(filas[2]![4]).toBeUndefined();
  });
});
