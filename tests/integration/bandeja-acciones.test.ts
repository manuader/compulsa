/**
 * Los envoltorios `*Action` de la bandeja, invocados como los invoca el navegador.
 *
 * Un archivo `'use server'` es puro cable: sesión, obra del estudio, núcleo,
 * `revalidatePath`. Justamente por no tener lógica nadie lo testeaba, y así
 * `buscarEnDocumentacionAction` quedó **muerta en runtime** con la suite entera
 * en verde: conservaba un `await import(/* webpackIgnore *\/ MODULO)` de cuando
 * el núcleo lo escribía otra rama en paralelo, el bundler dejaba el specifier
 * crudo, Node no resolvía el alias `@/` y el `catch` traducía el
 * `ERR_MODULE_NOT_FOUND` a "la búsqueda todavía no está disponible en esta
 * versión". El botón de la bandeja no hacía nada y lo decía en castellano.
 *
 * Este archivo es la red que faltaba: llama la acción de verdad y mira que el
 * núcleo **haya corrido** (su fila de auditoría, `busqueda_dirigida`). Si el
 * cable se vuelve a cortar, acá se ve.
 *
 * Los dos mocks son el request de Next que en un test no existe: `next/headers`
 * para la cookie de sesión y `next/cache` para el `revalidatePath` de las tres
 * pantallas. Nada del camino que se prueba pasa por ellos.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buscarEnDocumentacionAction,
  responderHallazgoAction,
} from '@/app/obras/[obraId]/bandeja/actions';
import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
} from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';

import { createTestDb } from '../helpers/test-db';

/** Cookie que ve el guard en la llamada que viene. `undefined` ⇒ sin sesión. */
let cookieActual: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      cookieActual && nombre === 'compulsa_session' ? { value: cookieActual } : undefined,
  }),
}));

const revalidaciones: string[] = [];
vi.mock('next/cache', () => ({
  revalidatePath: (ruta: string) => {
    revalidaciones.push(ruta);
  },
}));

/** La consulta que la búsqueda tiene que salir a contestar. */
const CLAVE = 'aberturas.medidas_vano.FP01';

let db: Db;
let obraId: string;
let entidadId: string;
let hallazgoId: string;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Ader' }).returning();
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
    .values({ estudioId: estudio.id, nombre: 'Casa Ader', zona: 'CABA', tipo: 'nueva' })
    .returning();
  obraId = obra.id;

  // La única lámina de la obra es una planta que ningún hallazgo cita: no es
  // candidata, así que la búsqueda corre entera sin abrir un PDF ni llamar al
  // provider. Alcanza para probar el cable —y deja el test sin storage y sin
  // fixtures—; que la búsqueda encuentre el dato en una planilla lo prueba
  // `tests/integration/busqueda.test.ts`.
  const [documento] = await db
    .insert(documentos)
    .values({
      obraId,
      nombreArchivo: 'planta.pdf',
      tipo: 'plano',
      archivoRef: 'no-se-lee',
      mime: 'application/pdf',
      hash: 'hash-planta',
      subidoPor: usuario.id,
    })
    .returning();
  const [lamina] = await db
    .insert(laminas)
    .values({
      documentoId: documento.id,
      obraId,
      numeroPagina: 1,
      codigo: 'A-01',
      tipo: 'planta',
      archivoRef: 'no-se-lee',
      estadoAnalisis: 'analizada',
    })
    .returning();

  const [entidad] = await db
    .insert(entidades)
    .values({
      obraId,
      laminaId: lamina.id,
      tipo: 'abertura',
      nombre: 'FP01',
      atributosJson: { tag: 'FP01' },
      estadoReforma: 'na',
      fuentesJson: [{ laminaId: lamina.id, bbox: [0.1, 0.1, 0.2, 0.2], detalle: 'FP01' }],
      confianza: 0.9,
    })
    .returning();
  entidadId = entidad.id;

  const [hallazgo] = await db
    .insert(hallazgos)
    .values({
      obraId,
      clave: CLAVE,
      tipo: 'faltante',
      rubro: 'aberturas',
      descripcion: 'Faltan el ancho y el alto del vano de FP01.',
      checklistItem: 'medidas_vano',
      laminasJson: [],
      targetRef: { entidadId: entidad.id, campos: ['anchoM', 'altoM'] },
      bloqueante: true,
    })
    .returning();
  hallazgoId = hallazgo.id;

  cookieActual = (await crearSesion(db, usuario.id)).token;
});

describe('buscarEnDocumentacionAction: el botón "Buscar los datos en la documentación"', () => {
  it('corre el núcleo de la búsqueda de verdad y revalida las tres pantallas', async () => {
    revalidaciones.length = 0;

    const resultado = await buscarEnDocumentacionAction({ obraId });

    expect(resultado).toEqual({ ok: true });

    // La prueba de que el núcleo corrió: la corrida deja su fila de auditoría.
    // Con el cable cortado la acción devolvía `ok:false` y acá no había nada.
    const corridas = await db
      .select()
      .from(auditoria)
      .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, 'busqueda_dirigida')));
    expect(corridas).toHaveLength(1);
    expect(corridas[0].diffJson).toMatchObject({ objetivos: 1, laminasConsultadas: 0 });

    expect(revalidaciones).toEqual([
      `/obras/${obraId}/bandeja`,
      `/obras/${obraId}/computo`,
      `/obras/${obraId}`,
    ]);
  });

  it('sin sesión no llega al núcleo', async () => {
    const token = cookieActual;
    cookieActual = undefined;
    try {
      await expect(buscarEnDocumentacionAction({ obraId })).rejects.toThrow();
    } finally {
      cookieActual = token;
    }
  });
});

describe('responderHallazgoAction: el otro envoltorio con núcleo del resolver', () => {
  it('escribe las dos medidas en la entidad y cierra la consulta', async () => {
    revalidaciones.length = 0;

    const resultado = await responderHallazgoAction({
      obraId,
      hallazgoId,
      valores: { anchoM: '0,90', altoM: '2,05' },
    });

    expect(resultado).toEqual({ ok: true });

    const [entidad] = await db.select().from(entidades).where(eq(entidades.id, entidadId));
    expect(entidad.atributosJson).toMatchObject({ anchoM: 0.9, altoM: 2.05 });

    const [fila] = await db.select().from(hallazgos).where(eq(hallazgos.id, hallazgoId));
    expect(fila.estado).toBe('respondido');
    expect(revalidaciones).toHaveLength(3);
  });
});
