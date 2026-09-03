/**
 * `GET /api/obras/[obraId]/memoria` contra PGlite.
 *
 * `tests/unit/memoria.test.ts` ya pinnea el markdown que arma `renderMemoriaMd`.
 * Lo que se prueba acá es lo que el render no puede saber: que el handler
 * **valide por su cuenta** —el `matcher` del middleware excluye `/api/*`, así
 * que sin este chequeo la memoria de una obra ajena se baja con una URL
 * adivinada (RNF-4)—, **qué filas entran** al documento y cómo se traducen las
 * de la base a la `EntradaMemoria`: el bbox que vive en la primera fuente, las
 * láminas citadas por código y no por uuid, y los hallazgos ya respondidos, que
 * no son lo que falta.
 *
 * `next/headers` va mockeado: `getSession()` lee la cookie de ahí y en un test
 * no hay request de Next. La cookie se controla con `cookieActual`.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/obras/[obraId]/memoria/route';
import { setDbForTests, type Db } from '@/db/client';
import {
  datosObra,
  deducciones,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
} from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import { SECCIONES_MD } from '@/lib/memoria/render';
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

const BBOX: BBox = [0.1, 0.2, 0.3, 0.05];

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
      escala: '1:50',
      escalaConfiable: true,
      archivoRef: 'ref-p1',
      estadoAnalisis: 'analizada',
    })
    .returning();
  // Sin rótulo leído: en el documento se nombra por id, que es lo único que
  // sigue siendo resoluble.
  const [corte] = await db
    .insert(laminas)
    .values({
      documentoId: doc.id,
      obraId: obra.id,
      numeroPagina: 2,
      codigo: null,
      titulo: 'Corte AA',
      tipo: 'corte',
      escala: '1:50',
      escalaConfiable: false,
      archivoRef: 'ref-p2',
      estadoAnalisis: 'analizada',
    })
    .returning();

  const [tabique] = await db
    .insert(entidades)
    .values({
      obraId: obra.id,
      laminaId: planta.id,
      tipo: 'tabique',
      nombre: 'T1',
      atributosJson: { largoM: 4 },
      estadoReforma: 'na',
      fuentesJson: [{ laminaId: planta.id, bbox: BBOX, detalle: 'T1' }],
      confianza: 0.9,
    })
    .returning();

  await db.insert(datosObra).values([
    {
      obraId: obra.id,
      clave: 'altura_local.PB',
      valorJson: { valor: 2.6, unidad: 'm' },
      origen: 'deducido',
      fuentesJson: [{ laminaId: corte.id, bbox: BBOX }],
      confianza: 0.8,
    },
    {
      obraId: obra.id,
      clave: 'altura_revestimiento.general',
      valorJson: { valor: 2, unidad: 'm' },
      origen: 'inferido',
      fuentesJson: [{ laminaId: planta.id, bbox: BBOX }],
      confianza: 0.5,
      metodo: 'medición gráfica sobre el dibujo a escala 1:50',
    },
    // Lo cargó una persona: es el único caso legítimo de `fuentes_json` vacío.
    {
      obraId: obra.id,
      clave: 'nivel.PB',
      valorJson: { valor: '±0,00' },
      origen: 'explicito',
      fuentesJson: [],
      confianza: 1,
      definidoPor: usuario.id,
    },
  ]);

  await db.insert(deducciones).values({
    obraId: obra.id,
    entidadId: tabique.id,
    campo: 'alturaM',
    regla: 'planta_corte',
    // La altura se leyó en el corte, no en la planta donde vive el tabique.
    fuentesJson: [{ laminaId: corte.id, bbox: BBOX }],
    valorJson: { alturaM: 2.6 },
    confianza: 0.8,
    estado: 'validada',
  });

  await db.insert(hallazgos).values([
    {
      obraId: obra.id,
      clave: 'seco.altura_tabiques.T2',
      tipo: 'faltante',
      rubro: 'seco',
      descripcion: 'Falta la altura del tabique T2.',
      laminasJson: [{ laminaId: planta.id, bbox: BBOX }],
      bloqueante: true,
      estado: 'abierto',
    },
    {
      obraId: obra.id,
      clave: 'cruce.conflicto.ab12cd34',
      tipo: 'inconsistencia',
      rubro: null,
      descripcion: 'El corte dice 2,60 y la planta 2,80.',
      laminasJson: [{ laminaId: corte.id, bbox: BBOX }],
      bloqueante: false,
      estado: 'abierto',
    },
    // Ya contestado: no es información faltante y no entra al documento.
    {
      obraId: obra.id,
      clave: 'seco.altura_tabiques.T1',
      tipo: 'faltante',
      rubro: 'seco',
      descripcion: 'Falta la altura del tabique T1.',
      laminasJson: [{ laminaId: planta.id, bbox: BBOX }],
      bloqueante: true,
      estado: 'respondido',
    },
  ]);

  token = (await crearSesion(db, usuario.id)).token;
});

function pedir(id = obraId): Promise<Response> {
  return GET(new Request(`http://localhost/api/obras/${id}/memoria`), {
    params: Promise.resolve({ obraId: id }),
  });
}

describe('GET /api/obras/[obraId]/memoria: quién puede bajarla', () => {
  it('sin sesión responde 401 y no manda una línea del documento', async () => {
    cookieActual = undefined;

    const res = await pedir();

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: 'Iniciá sesión para seguir.' });
  });

  it('con una obra de otro estudio responde 404 (RNF-4), y con un id mal formado también', async () => {
    cookieActual = token;

    const ajena = await pedir(obraAjenaId);
    expect(ajena.status).toBe(404);
    expect(await ajena.json()).toEqual({ error: 'Esa obra no existe.' });
    expect((await pedir('no-es-un-uuid')).status).toBe(404);
  });
});

describe('GET /api/obras/[obraId]/memoria: el documento', () => {
  it('baja un .md con el nombre de la obra y sin caché', async () => {
    cookieActual = token;

    const res = await pedir();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="memoria-de-obra-casa-perez-\d{4}-\d{2}-\d{2}\.md"$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('trae las 7 secciones del §27 y encabeza con la obra', async () => {
    cookieActual = token;

    const texto = await (await pedir()).text();

    expect(texto).toContain('# Memoria de obra — Casa Pérez');
    expect(texto).toContain('Obra de reforma · 2 láminas · 1 elemento');
    for (const seccion of SECCIONES_MD) expect(texto).toContain(`## ${seccion}`);
  });

  it('cita las láminas por código y marca la escala que nadie confirmó', async () => {
    cookieActual = token;

    const texto = await (await pedir()).text();

    expect(texto).toContain('| A-01 | Planta baja | Planta | 1:50 (confirmada) | Analizada |');
    expect(texto).toContain('| Corte AA | Corte | 1:50 (asumida) | Analizada |');
    // El elemento sale bajo su lámina, con el largo que trae el atributo.
    expect(texto).toContain('### A-01');
    expect(texto).toContain('| T1 | Tabique | — | largo = 4 |');
  });

  it('el dato de obra cita su lámina, y el que cargó una persona no miente una fuente', async () => {
    cookieActual = token;

    const texto = await (await pedir()).text();

    expect(texto).toContain('| Altura de local en PB | 2,6 m | Deducido | 80% |');
    // `fuentes_json` vacío es legítimo solo acá: lo cargó el arquitecto.
    expect(texto).toContain('| Nivel en PB | ±0,00 | Explícito | 100% | — | — |');
  });

  it('la deducción se cita en la lámina donde se leyó el dato, no en la de la entidad', async () => {
    cookieActual = token;

    const texto = await (await pedir()).text();

    // T1 vive en A-01, pero la altura salió del corte: esa es la lámina a abrir.
    // El corte no tiene código leído, así que se nombra por su página — antes
    // salía su uuid, que es lo que este arreglo vino a sacar del documento.
    expect(texto).toContain('| T1 | altura | Planta ↔ corte | 80% | Validada | Página 2 |');
    expect(texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('separa el conflicto de lo faltante y deja afuera lo ya respondido', async () => {
    cookieActual = token;

    const texto = await (await pedir()).text();

    expect(texto).toContain('| cruce.conflicto.ab12cd34 | El corte dice 2,60 y la planta 2,80. | No |');
    expect(texto).toContain('| seco.altura_tabiques.T2 | Faltante | Falta la altura del tabique T2. | Sí |');
    // La consulta respondida ya no es lo que falta.
    expect(texto).not.toContain('seco.altura_tabiques.T1');
  });

  it('lo inferido va con su método: es lo que hay que verificar antes de comprar', async () => {
    cookieActual = token;

    const texto = await (await pedir()).text();

    expect(texto).toContain(
      '| Altura de revestimiento | 2 m | medición gráfica sobre el dibujo a escala 1:50 | 50% |',
    );
    expect(texto).toContain('_La plataforma asiste');
  });
});
