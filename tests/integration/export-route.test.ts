/**
 * `GET /api/obras/[obraId]/export` contra PGlite.
 *
 * `tests/unit/export.test.ts` ya prueba el libro que arma `generarXlsx()`. Lo
 * que se prueba acá es lo que el generador no puede saber: que el handler
 * **valide por su cuenta** —el `matcher` del middleware excluye `/api/*`, así
 * que si esta route no chequea sesión y estudio, el cómputo de una obra ajena
 * se baja con una URL adivinada (RNF-4)— y que la respuesta salga con los
 * headers de descarga que el navegador necesita.
 *
 * `next/headers` va mockeado: `getSession()` lee la cookie de ahí y no hay
 * request de Next en un test. La cookie se controla con `cookieActual`.
 */
import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/obras/[obraId]/export/route';
import { setDbForTests, type Db } from '@/db/client';
import {
  computoItems,
  computoRubros,
  documentos,
  estudios,
  laminas,
  obras,
  usuarios,
} from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import { PLANTILLAS } from '@/lib/rubros';
import { RUBROS } from '@/types/domain';

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

let db: Db;
let obraId: string;
let obraAjenaId: string;
let token: string;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Ader' }).returning();
  // Segundo estudio con su propia obra: es el control del aislamiento.
  const [estudioAjeno] = await db.insert(estudios).values({ nombre: 'Otro estudio' }).returning();

  const [usuario] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'manu@estudioader.ar',
      nombre: 'Manu',
      // El test no pasa por el login: la sesión se crea a mano más abajo.
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

  const [lamina] = await db
    .insert(laminas)
    .values({
      documentoId: doc.id,
      obraId: obra.id,
      numeroPagina: 1,
      codigo: 'A-01',
      titulo: 'Planta baja',
      archivoRef: 'ref-p1',
      estadoAnalisis: 'analizada',
    })
    .returning();

  await db.insert(computoItems).values([
    {
      obraId: obra.id,
      rubro: 'seco',
      claveItem: 'seco.placas',
      descripcion: 'Placas de roca de yeso 12,5 mm',
      unidad: 'm2',
      cantNeta: 31.68,
      desperdicioPct: 10,
      cantCompra: 34.85,
      presentacion: '13 placas',
      origen: 'deducido',
      fuentesJson: [{ laminaId: lamina.id, bbox: [0.1, 0.2, 0.3, 0.4] }],
      confianza: 0.86,
      estado: 'activo',
    },
    {
      obraId: obra.id,
      rubro: 'pintura',
      claveItem: 'pintura.latex',
      descripcion: 'Látex interior',
      unidad: 'l',
      cantNeta: 24.5,
      desperdicioPct: 5,
      cantCompra: 25.73,
      presentacion: '1 lata de 20 L',
      origen: 'supuesto',
      fuentesJson: [],
      confianza: 0.72,
      estado: 'activo',
    },
    {
      // Anulado: la base no lo borra, pero el export no puede mostrarlo.
      obraId: obra.id,
      rubro: 'seco',
      claveItem: 'seco.montantes',
      descripcion: 'Montantes 70 mm',
      unidad: 'u',
      cantNeta: 26,
      desperdicioPct: 0,
      cantCompra: 26,
      presentacion: '26 barras',
      origen: 'deducido',
      fuentesJson: [{ laminaId: lamina.id, bbox: [0, 0, 1, 1] }],
      confianza: 0.9,
      estado: 'anulado',
    },
  ]);

  // `pintura` queda sin fila a propósito: tiene que salir como 'Borrador'.
  await db.insert(computoRubros).values({ obraId: obra.id, rubro: 'seco', estado: 'aprobado' });

  token = (await crearSesion(db, usuario.id)).token;
});

function pedir(query = '', id = obraId): Promise<Response> {
  return GET(new Request(`http://localhost/api/obras/${id}/export${query}`), {
    params: Promise.resolve({ obraId: id }),
  });
}

async function libroDe(res: Response): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer);
  return wb;
}

describe('GET /api/obras/[obraId]/export: quién puede bajar el cómputo', () => {
  it('sin sesión responde 401 y no manda un byte del libro', async () => {
    cookieActual = undefined;

    const res = await pedir();

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('con una obra de otro estudio responde 404 (RNF-4)', async () => {
    cookieActual = token;

    const res = await pedir('', obraAjenaId);

    expect(res.status).toBe(404);
  });

  it('con un obraId mal formado responde 404, no un 500 del driver', async () => {
    cookieActual = token;

    const res = await pedir('', 'no-es-un-uuid');

    expect(res.status).toBe(404);
  });

  it('con un rubro que no existe responde 400 en vez de degradar a todos', async () => {
    cookieActual = token;

    const res = await pedir('?rubro=techos');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No conozco el rubro "techos".' });
  });
});

describe('GET /api/obras/[obraId]/export: la descarga', () => {
  it('sale como adjunto xlsx con el nombre computo-<slug>-consolidado-<fecha>.xlsx', async () => {
    cookieActual = token;

    const res = await pedir();
    const cuerpo = await res.arrayBuffer();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(MIME_XLSX);
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="computo-casa-perez-consolidado-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    // El header no puede mentir sobre el tamaño de lo que efectivamente se manda.
    expect(res.headers.get('content-length')).toBe(String(cuerpo.byteLength));
    // Aprobar un rubro cambia el archivo sin cambiar la URL.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sin ?rubro trae una hoja por rubro, la consolidada y las referencias', async () => {
    cookieActual = token;

    const wb = await libroDe(await pedir());

    // Ver `tests/unit/export.test.ts`: la regla es «una hoja por rubro,
    // siempre», así que la lista se deriva de `RUBROS`.
    expect(wb.worksheets.map((h) => h.name)).toEqual([
      ...RUBROS.map((rubro) => PLANTILLAS[rubro].nombre),
      'Consolidado',
      'Referencias',
    ]);
  });

  it('trae los datos de la base con el estado del rubro y la lámina de origen', async () => {
    cookieActual = token;

    const seco = (await libroDe(await pedir())).getWorksheet(PLANTILLAS.seco.nombre)!;

    expect(seco.getCell('A2').value).toBe('seco.placas');
    expect(seco.getCell('B2').value).toBe('Placas de roca de yeso 12,5 mm');
    expect(seco.getCell('D2').value).toBe(31.68);
    expect(seco.getCell('F2').value).toBe(34.85);
    // Sale de `computo_rubros`, no del ítem.
    expect(seco.getCell('J2').value).toBe('Aprobado');
    // El uuid de `fuentes_json` traducido al código que el arquitecto reconoce.
    expect(seco.getCell('K2').value).toBe('A-01');
  });

  it('deja afuera el ítem anulado', async () => {
    cookieActual = token;
    const wb = await libroDe(await pedir());

    // Encabezado + `seco.placas`: `seco.montantes` no entra.
    expect(wb.getWorksheet(PLANTILLAS.seco.nombre)!.rowCount).toBe(2);

    const claves: unknown[] = [];
    wb.getWorksheet('Consolidado')!.eachRow((row) => claves.push(row.getCell(2).value));
    expect(claves).toEqual(['Clave', 'seco.placas', 'pintura.latex']);
  });

  it('con ?rubro=<id> baja solo esa hoja, las referencias y nombra el rubro', async () => {
    cookieActual = token;

    const res = await pedir('?rubro=pintura');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="computo-casa-perez-pintura-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );

    const wb = await libroDe(res);

    expect(wb.worksheets.map((h) => h.name)).toEqual([PLANTILLAS.pintura.nombre, 'Referencias']);
    const pintura = wb.getWorksheet(PLANTILLAS.pintura.nombre)!;
    expect(pintura.getCell('B2').value).toBe('Látex interior');
    // Sin fila en `computo_rubros`, el rubro está en borrador.
    expect(pintura.getCell('J2').value).toBe('Borrador');
    expect(pintura.rowCount).toBe(2);
  });

  it('con ?rubro=todos baja lo mismo que sin el parámetro', async () => {
    cookieActual = token;

    const wb = await libroDe(await pedir('?rubro=todos'));

    expect(wb.worksheets).toHaveLength(RUBROS.length + 2);
    expect(wb.getWorksheet('Consolidado')!.rowCount).toBe(3);
  });

  it('trata ?rubro= vacío como "no lo especifiqué"', async () => {
    cookieActual = token;

    const res = await pedir('?rubro=');

    expect(res.status).toBe(200);
    expect((await libroDe(res)).worksheets).toHaveLength(RUBROS.length + 2);
  });
});
