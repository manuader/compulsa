/**
 * Rechazar un **dato de obra que escribió el cruce**, de punta a punta.
 *
 * Es el agujero que la ola dejó abierto: una deducción auto-validada —que toca
 * UN elemento— se rechazaba con un click desde la primera versión de la solapa
 * «Para revisar», y un `datos_obra` escrito por el cruce —que corre los metros
 * de **todos** los rubros de un nivel— no tenía ni un botón. Si el modelo leía
 * 2,06 donde el corte dice 2,60, el error entraba al cómputo marcado `deducido`
 * y no había forma de sacarlo.
 *
 * Lo que se prueba acá, y no otra cosa:
 *
 *  1. rechazar **borra la fila** (la tabla no tiene estado: la clave es única
 *     por obra y el recompute lee lo que hay);
 *  2. deja su rastro en `auditoria` con el valor que se fue;
 *  3. **corre el recompute**, que es lo que reabre la pregunta;
 *  4. un dato que cargó una persona (`definido_por` seteado) NO se toca por
 *     este camino: se vuelve a contestar la consulta;
 *  5. un dato de otra obra no existe (RNF-4), y da el mismo error que uno
 *     inventado.
 *
 * Los dos mocks son el request de Next que en un test no existe: `next/headers`
 * para la cookie y `next/cache` para el `revalidatePath`.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { rechazarDatoDeObraAction } from '@/app/obras/[obraId]/bandeja/actions';
import { setDbForTests, type Db } from '@/db/client';
import { auditoria, datosObra, estudios, obras, usuarios } from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import {
  ACCION_DATO_RECHAZADO,
  ES_TUYO,
  NO_ENCONTRADO,
  rechazarDatoDeObra,
} from '@/lib/datos-obra/persistencia';

import { createTestDb } from '../helpers/test-db';

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

let db: Db;
let obraId: string;
let otraObraId: string;
let usuarioId: string;
let email: string;

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
  usuarioId = usuario.id;
  email = usuario.email;

  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa Ader', zona: 'CABA', tipo: 'reforma' })
    .returning();
  obraId = obra.id;

  const [otra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Depto Salguero', zona: 'CABA', tipo: 'reforma' })
    .returning();
  otraObraId = otra.id;

  cookieActual = (await crearSesion(db, usuario.id)).token;
});

/** El hecho que el cruce escribió: sin `definido_por`, o sea del sistema. */
async function sembrarDelCruce(clave = 'altura_local.PB'): Promise<string> {
  const [fila] = await db
    .insert(datosObra)
    .values({
      obraId,
      clave,
      valorJson: { valor: 2.06, unidad: 'm' },
      origen: 'deducido',
      fuentesJson: [],
      confianza: 0.82,
      metodo: null,
    })
    .returning();
  return fila.id;
}

beforeEach(async () => {
  await db.delete(datosObra).where(eq(datosObra.obraId, obraId));
  await db.delete(auditoria).where(eq(auditoria.obraId, obraId));
  revalidaciones.length = 0;
});

describe('rechazarDatoDeObra: el núcleo', () => {
  it('borra la fila y deja el valor que se fue en la auditoría', async () => {
    const datoId = await sembrarDelCruce();

    const resultado = await rechazarDatoDeObra(
      { obraId, datoId },
      { usuarioId, email, rol: 'colaborador' },
    );

    expect(resultado).toEqual({ ok: true });
    expect(await db.select().from(datosObra).where(eq(datosObra.id, datoId))).toHaveLength(0);

    const [registro] = await db
      .select()
      .from(auditoria)
      .where(and(eq(auditoria.obraId, obraId), eq(auditoria.accion, ACCION_DATO_RECHAZADO)));
    expect(registro.targetRef).toBe('datos_obra:altura_local.PB');
    expect(registro.diffJson).toMatchObject({ valor: { antes: 2.06, despues: null } });
  });

  it('un dato que cargó una persona no se rechaza por acá', async () => {
    const [fila] = await db
      .insert(datosObra)
      .values({
        obraId,
        clave: 'altura_local.1P',
        valorJson: { valor: 2.6, unidad: 'm' },
        origen: 'explicito',
        fuentesJson: [],
        confianza: 1,
        definidoPor: usuarioId,
      })
      .returning();

    const resultado = await rechazarDatoDeObra(
      { obraId, datoId: fila.id },
      { usuarioId, email, rol: 'colaborador' },
    );

    expect(resultado).toEqual({ ok: false, error: ES_TUYO });
    expect(await db.select().from(datosObra).where(eq(datosObra.id, fila.id))).toHaveLength(1);
  });

  it('un dato de otra obra no existe (RNF-4) y no se filtra que existe', async () => {
    const [ajeno] = await db
      .insert(datosObra)
      .values({
        obraId: otraObraId,
        clave: 'altura_local.PB',
        valorJson: { valor: 2.4, unidad: 'm' },
        origen: 'deducido',
        fuentesJson: [],
        confianza: 0.8,
      })
      .returning();

    const resultado = await rechazarDatoDeObra(
      { obraId, datoId: ajeno.id },
      { usuarioId, email, rol: 'colaborador' },
    );

    expect(resultado).toEqual({ ok: false, error: NO_ENCONTRADO });
    expect(await db.select().from(datosObra).where(eq(datosObra.id, ajeno.id))).toHaveLength(1);
  });

  it('un usuario de solo lectura no puede rechazar (RF-1201)', async () => {
    const datoId = await sembrarDelCruce();

    const resultado = await rechazarDatoDeObra(
      { obraId, datoId },
      { usuarioId, email, rol: 'lectura' },
    );

    expect(resultado.ok).toBe(false);
    expect(await db.select().from(datosObra).where(eq(datosObra.id, datoId))).toHaveLength(1);
  });
});

describe('rechazarDatoDeObraAction: el envoltorio que llama la pantalla', () => {
  it('borra el dato y revalida las tres pantallas que lo mostraban', async () => {
    const datoId = await sembrarDelCruce();

    const resultado = await rechazarDatoDeObraAction({ obraId, datoId });

    expect(resultado).toEqual({ ok: true });
    expect(await db.select().from(datosObra).where(eq(datosObra.id, datoId))).toHaveLength(0);
    expect(revalidaciones).toEqual([
      `/obras/${obraId}/bandeja`,
      `/obras/${obraId}/computo`,
      `/obras/${obraId}`,
    ]);
  });

  it('sin sesión no llega al núcleo', async () => {
    const datoId = await sembrarDelCruce();
    const token = cookieActual;
    cookieActual = undefined;
    try {
      await expect(rechazarDatoDeObraAction({ obraId, datoId })).rejects.toThrow();
    } finally {
      cookieActual = token;
    }
    expect(await db.select().from(datosObra).where(eq(datosObra.id, datoId))).toHaveLength(1);
  });
});
