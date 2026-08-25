/**
 * Alta de obra: el núcleo de `src/app/obras/actions.ts` contra PGlite.
 *
 * Se testea `crearObraCore` y no el server action: la action solo resuelve la
 * sesión y arma el `FormData`; lo que hay que proteger es la validación y lo
 * que termina escrito en la tabla.
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { crearObraCore } from '@/app/obras/actions';
import { setDbForTests, type Db } from '@/db/client';
import { estudios, obras } from '@/db/schema';

import { createTestDb } from '../helpers/test-db';

let db: Db;
let estudioId: string;
let otroEstudioId: string;

const VALIDA = {
  nombre: 'Casa Belgrano',
  zona: 'CABA — Belgrano R',
  tipo: 'reforma',
  moneda: 'ARS',
};

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);

  const [estudio, otro] = await db
    .insert(estudios)
    .values([{ nombre: 'Estudio Norte' }, { nombre: 'Estudio Sur' }])
    .returning();
  estudioId = estudio.id;
  otroEstudioId = otro.id;
});

describe('crearObraCore', () => {
  it('persiste una obra válida en el estudio de la sesión', async () => {
    const resultado = await crearObraCore(db, estudioId, VALIDA);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.obra.nombre).toBe('Casa Belgrano');
    expect(resultado.obra.zona).toBe('CABA — Belgrano R');
    expect(resultado.obra.tipo).toBe('reforma');
    expect(resultado.obra.moneda).toBe('ARS');
    expect(resultado.obra.estado).toBe('activa');
    expect(resultado.obra.estudioId).toBe(estudioId);

    const guardadas = await db.select().from(obras).where(eq(obras.estudioId, estudioId));
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0].id).toBe(resultado.obra.id);
    expect(guardadas[0].nombre).toBe('Casa Belgrano');
  });

  it('recorta los espacios de nombre y zona antes de guardar', async () => {
    const resultado = await crearObraCore(db, estudioId, {
      ...VALIDA,
      nombre: '  Casa Belgrano  ',
      zona: ' Belgrano R ',
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.obra.nombre).toBe('Casa Belgrano');
    expect(resultado.obra.zona).toBe('Belgrano R');
  });

  it('rechaza un tipo de obra que no existe y no escribe nada', async () => {
    const resultado = await crearObraCore(db, estudioId, { ...VALIDA, tipo: 'demolicion' });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.errores).toEqual({ tipo: 'Elegí si es obra nueva, reforma o ampliación.' });

    expect(await db.select().from(obras)).toHaveLength(0);
  });

  it('exige nombre, zona, tipo y moneda con un mensaje por campo', async () => {
    const resultado = await crearObraCore(db, estudioId, { nombre: '   ', zona: '' });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.errores).toEqual({
      nombre: 'Poné el nombre de la obra.',
      zona: 'Poné la zona o localidad de la obra.',
      tipo: 'Elegí si es obra nueva, reforma o ampliación.',
      moneda: 'Elegí la moneda con la que vas a computar.',
    });

    expect(await db.select().from(obras)).toHaveLength(0);
  });

  it('ignora los campos que el cliente mande de más', async () => {
    // El payload intenta colarse en otro estudio y nacer archivado: Zod deja
    // pasar solo los cuatro campos del formulario, el resto lo pone el server.
    const resultado = await crearObraCore(db, estudioId, {
      ...VALIDA,
      estudioId: otroEstudioId,
      estado: 'archivada',
      id: '11111111-1111-1111-1111-111111111111',
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.obra.estudioId).toBe(estudioId);
    expect(resultado.obra.estado).toBe('activa');
    expect(resultado.obra.id).not.toBe('11111111-1111-1111-1111-111111111111');

    expect(await db.select().from(obras).where(eq(obras.estudioId, otroEstudioId))).toHaveLength(0);
  });
});
