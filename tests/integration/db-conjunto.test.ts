/**
 * El esquema del «expediente como conjunto» sobre PGlite en memoria.
 *
 * Tres cosas se verifican acá y en ningún otro lado:
 *
 *  1. las dos tablas nuevas —`datos_obra` (un hecho por obra y clave) y
 *     `precios_referencia` (la lista del estudio)— con sus unicidades, que son
 *     su razón de ser: un dato de obra repetido es un dato de obra contradicho,
 *     y un precio repetido es la ambigüedad que la cascada de precios no puede
 *     resolver;
 *  2. las cuatro columnas nuevas sobre tablas viejas (`computo_items.precio_json`,
 *     `hallazgos.target_dato`, `entidades.elemento_id`, `obras.analisis_json`) y
 *     los valores que los `ALTER TYPE … ADD VALUE` sumaron a cuatro enums;
 *  3. que todo eso **se posa sobre una base con datos de F0 sin romperla**.
 *     `createTestDb()` corre TODAS las migraciones, así que —igual que en
 *     `db-f1.test.ts`— eso se comprueba por su consecuencia observable: la
 *     cadena F0 completa se sigue insertando como se insertaba, con las
 *     columnas nuevas en su default.
 */
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  computoItems,
  datosObra,
  deducciones,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  preciosReferencia,
  usuarios,
} from '@/db/schema';
import type {
  DatoObraValor,
  FaseAnalisis,
  Fuente,
  PrecioEstimado,
  TargetDato,
} from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

/** Igual que en `db-f1.test.ts`: el detalle de Postgres viaja en `cause`. */
async function violacionUnica(accion: Promise<unknown>): Promise<string> {
  try {
    await accion;
  } catch (error) {
    const causa = (error as Error).cause as {
      code?: string;
      message?: string;
      constraint?: string;
      constraint_name?: string;
    };
    expect(causa?.code).toBe('23505');
    return (
      causa.constraint_name ??
      causa.constraint ??
      /unique constraint "([^"]+)"/.exec(causa.message ?? '')?.[1] ??
      ''
    );
  }
  throw new Error('Se esperaba una violación de unicidad y la inserción pasó.');
}

async function sembrarObra() {
  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Conjunto' }).returning();
  const [usuario] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'ana@estudioconjunto.ar',
      nombre: 'Ana Beltrán',
      passwordHash: 'scrypt$no-usado-en-este-test',
      rol: 'titular',
    })
    .returning();
  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa Devoto', zona: 'CABA', tipo: 'reforma' })
    .returning();
  const [documento] = await db
    .insert(documentos)
    .values({
      obraId: obra.id,
      nombreArchivo: 'planta.pdf',
      tipo: 'plano',
      archivoRef: `obras/${obra.id}/documentos/planta.pdf`,
      mime: 'application/pdf',
      hash: 'e3b0c44298fc1c14',
      subidoPor: usuario.id,
    })
    .returning();
  const [lamina] = await db
    .insert(laminas)
    .values({
      documentoId: documento.id,
      obraId: obra.id,
      numeroPagina: 1,
      codigo: 'A-01',
      titulo: 'Planta baja',
      tipo: 'planta',
      escala: '1:50',
      archivoRef: `obras/${obra.id}/laminas/planta-p1.pdf`,
    })
    .returning();
  return { estudio, usuario, obra, documento, lamina };
}

const ALTURA_PB: DatoObraValor = { valor: 2.6, unidad: 'm' };

describe('datos_obra: un hecho por obra y clave', () => {
  it('guarda el dato con su provenance y sus defaults', async () => {
    const { obra, lamina } = await sembrarObra();
    const fuentes: Fuente[] = [{ laminaId: lamina.id, bbox: [0.1, 0.8, 0.2, 0.05], detalle: 'A-01' }];

    const [fila] = await db
      .insert(datosObra)
      .values({
        obraId: obra.id,
        clave: 'altura_local.PB',
        valorJson: ALTURA_PB,
        origen: 'deducido',
        fuentesJson: fuentes,
        confianza: 0.85,
      })
      .returning();

    expect(fila.clave).toBe('altura_local.PB');
    expect(fila.valorJson).toEqual(ALTURA_PB);
    expect(fila.origen).toBe('deducido');
    expect(fila.fuentesJson).toEqual(fuentes);
    expect(fila.confianza).toBe(0.85);
    // Los dos que nacen vacíos: `metodo` solo lo llena lo inferido, y
    // `definido_por` es la marca de "esto lo cargó una persona, no lo pises".
    expect(fila.metodo).toBeNull();
    expect(fila.definidoPor).toBeNull();
    expect(fila.updatedAt).toBeInstanceOf(Date);
  });

  it('rechaza dos filas con la misma clave en la misma obra', async () => {
    const { obra } = await sembrarObra();
    const valores = {
      obraId: obra.id,
      clave: 'altura_local.PB',
      valorJson: ALTURA_PB,
      origen: 'explicito' as const,
      fuentesJson: [] as Fuente[],
      confianza: 1,
    };
    await db.insert(datosObra).values(valores);

    const constraint = await violacionUnica(
      db.insert(datosObra).values({ ...valores, valorJson: { valor: 2.8, unidad: 'm' } }),
    );
    expect(constraint).toBe('datos_obra_obra_clave_uq');
  });

  it('la misma clave en dos obras distintas convive', async () => {
    const primera = await sembrarObra();
    const [otra] = await db
      .insert(obras)
      .values({
        estudioId: primera.estudio.id,
        nombre: 'Casa Flores',
        zona: 'CABA',
        tipo: 'nueva',
      })
      .returning();

    for (const obraId of [primera.obra.id, otra.id]) {
      await db.insert(datosObra).values({
        obraId,
        clave: 'altura_local.PB',
        valorJson: ALTURA_PB,
        origen: 'supuesto',
        fuentesJson: [],
        confianza: 0.5,
      });
    }

    const filas = await db.select().from(datosObra);
    expect(filas).toHaveLength(2);
  });

  it("acepta el origen 'inferido' y guarda el método que lo explica", async () => {
    const { obra, lamina } = await sembrarObra();
    const [fila] = await db
      .insert(datosObra)
      .values({
        obraId: obra.id,
        clave: 'altura_revestimiento.Baño',
        valorJson: { valor: 2, unidad: 'm' },
        origen: 'inferido',
        fuentesJson: [{ laminaId: lamina.id, bbox: [0, 0, 1, 1] }],
        confianza: 0.5,
        metodo: 'medición gráfica sobre el dibujo a escala 1:50',
      })
      .returning();

    expect(fila.origen).toBe('inferido');
    expect(fila.metodo).toBe('medición gráfica sobre el dibujo a escala 1:50');
  });

  it('un dato definido por el usuario apunta a quién lo cargó', async () => {
    const { obra, usuario } = await sembrarObra();
    const [fila] = await db
      .insert(datosObra)
      .values({
        obraId: obra.id,
        clave: 'nivel.PB',
        valorJson: { valor: '±0.00' },
        origen: 'explicito',
        fuentesJson: [],
        confianza: 1,
        definidoPor: usuario.id,
      })
      .returning();

    expect(fila.definidoPor).toBe(usuario.id);
    expect(fila.valorJson).toEqual({ valor: '±0.00' });
  });
});

describe('precios_referencia: la lista del estudio', () => {
  it('guarda el precio con su moneda por default', async () => {
    const { estudio } = await sembrarObra();
    const [fila] = await db
      .insert(preciosReferencia)
      .values({
        estudioId: estudio.id,
        claveItem: 'seco.placas',
        descripcion: 'Placa de roca de yeso 12,5 mm',
        unidad: 'm2',
        precio: 18_500.5,
        fecha: '2026-08-01',
        origen: 'csv',
      })
      .returning();

    expect(fila.moneda).toBe('ARS');
    expect(fila.precio).toBe(18_500.5);
    expect(fila.unidad).toBe('m2');
    expect(fila.origen).toBe('csv');
    expect(fila.fecha).toBe('2026-08-01');
  });

  it('rechaza dos precios para la misma clave en el mismo estudio', async () => {
    const { estudio } = await sembrarObra();
    const valores = {
      estudioId: estudio.id,
      claveItem: 'terminaciones.contrapiso',
      descripcion: 'Contrapiso',
      unidad: 'm2' as const,
      precio: 9_000,
      fecha: '2026-08-01',
      origen: 'manual' as const,
    };
    await db.insert(preciosReferencia).values(valores);

    const constraint = await violacionUnica(
      db.insert(preciosReferencia).values({ ...valores, precio: 9_500 }),
    );
    expect(constraint).toBe('precios_referencia_estudio_clave_uq');
  });

  it('la misma clave en dos estudios distintos convive', async () => {
    const { estudio } = await sembrarObra();
    const [otro] = await db.insert(estudios).values({ nombre: 'Estudio Sur' }).returning();

    for (const estudioId of [estudio.id, otro.id]) {
      await db.insert(preciosReferencia).values({
        estudioId,
        claveItem: 'seco.placas',
        descripcion: 'Placa de roca de yeso 12,5 mm',
        unidad: 'm2',
        precio: 18_500,
        fecha: '2026-08-01',
        origen: 'manual',
      });
    }

    const filas = await db.select().from(preciosReferencia);
    expect(filas).toHaveLength(2);
  });
});

describe('columnas nuevas sobre tablas viejas', () => {
  it('computo_items.precio_json nace nulo y guarda el precio con su fuente', async () => {
    const { obra, lamina } = await sembrarObra();
    const fuentes: Fuente[] = [{ laminaId: lamina.id, bbox: [0.1, 0.2, 0.3, 0.4] }];
    const [item] = await db
      .insert(computoItems)
      .values({
        obraId: obra.id,
        rubro: 'terminaciones',
        claveItem: 'terminaciones.solado.porcelanato',
        descripcion: 'Solado de porcelanato',
        unidad: 'm2',
        cantNeta: 12,
        desperdicioPct: 10,
        cantCompra: 13.2,
        presentacion: '13,20 m²',
        origen: 'inferido',
        fuentesJson: fuentes,
        confianza: 0.5,
      })
      .returning();

    expect(item.precioJson).toBeNull();
    expect(item.rubro).toBe('terminaciones');
    expect(item.origen).toBe('inferido');

    const precio: PrecioEstimado = {
      unitario: 32_000,
      moneda: 'ARS',
      fuente: 'lista',
      fechaPrecio: '2026-08-01',
    };
    const [conPrecio] = await db
      .update(computoItems)
      .set({ precioJson: precio })
      .where(eq(computoItems.id, item.id))
      .returning();
    expect(conPrecio.precioJson).toEqual(precio);
  });

  it('hallazgos.target_dato nace nulo y guarda a quiénes afecta el dato faltante', async () => {
    const { obra, lamina } = await sembrarObra();
    const [entidad] = await db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'tabique',
        nombre: 'T1',
        atributosJson: { largoM: 4, nivel: 'PB' },
        fuentesJson: [{ laminaId: lamina.id, bbox: [0, 0, 1, 1] }],
        confianza: 0.9,
      })
      .returning();

    const [hallazgo] = await db
      .insert(hallazgos)
      .values({
        obraId: obra.id,
        clave: 'dato_obra.altura_local.PB',
        tipo: 'faltante',
        rubro: 'seco',
        descripcion: 'No encontré la altura de local de PB.',
        laminasJson: [],
        bloqueante: false,
      })
      .returning();
    expect(hallazgo.targetDato).toBeNull();

    const target: TargetDato = {
      clave: 'altura_local.PB',
      unidad: 'm',
      entidades: [entidad.id],
    };
    const [conTarget] = await db
      .update(hallazgos)
      .set({ targetDato: target })
      .where(eq(hallazgos.id, hallazgo.id))
      .returning();
    expect(conTarget.targetDato).toEqual(target);
  });

  it('entidades.elemento_id agrupa el mismo elemento físico sin FK', async () => {
    const { obra, lamina } = await sembrarObra();
    // Es un id de GRUPO, no una FK: no apunta a ninguna fila, y por eso un uuid
    // que no existe en ninguna tabla se guarda sin chistar.
    const elementoId = '11111111-2222-3333-4444-555555555555';

    const [enPlanta] = await db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'muro',
        nombre: 'M1 (planta)',
        atributosJson: { largoM: 4 },
        fuentesJson: [{ laminaId: lamina.id, bbox: [0, 0, 0.5, 0.5] }],
        confianza: 0.9,
        elementoId,
      })
      .returning();
    const [enCorte] = await db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'muro',
        nombre: 'M1 (corte)',
        atributosJson: { alturaM: 2.6 },
        fuentesJson: [{ laminaId: lamina.id, bbox: [0.5, 0, 0.5, 0.5] }],
        confianza: 0.9,
        elementoId,
      })
      .returning();

    expect(enPlanta.elementoId).toBe(elementoId);
    const grupo = await db
      .select()
      .from(entidades)
      .where(and(eq(entidades.obraId, obra.id), eq(entidades.elementoId, elementoId)));
    expect(grupo.map((e) => e.id).sort()).toEqual([enPlanta.id, enCorte.id].sort());
  });

  it('obras.analisis_json nace nulo y guarda la fase en curso', async () => {
    const { obra } = await sembrarObra();
    expect(obra.analisisJson).toBeNull();

    const fase: FaseAnalisis = { fase: 'extraccion', total: 25, completadas: 12 };
    const [conFase] = await db
      .update(obras)
      .set({ analisisJson: fase })
      .where(eq(obras.id, obra.id))
      .returning();
    expect(conFase.analisisJson).toEqual(fase);
  });
});

describe('valores nuevos de los enums (ALTER TYPE … ADD VALUE)', () => {
  it('acepta los tres tipos de entidad de instalaciones', async () => {
    const { obra, lamina } = await sembrarObra();
    const fuentes: Fuente[] = [{ laminaId: lamina.id, bbox: [0.2, 0.2, 0.1, 0.1] }];

    await db.insert(entidades).values([
      {
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'tramo',
        nombre: 'AC-01',
        atributosJson: { sistema: 'ac', diametro: '20', longitudM: 2 },
        fuentesJson: fuentes,
        confianza: 0.9,
      },
      {
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'accesorio',
        nombre: 'Codo 1',
        atributosJson: { tipo: 'codo90', sistema: 'ac', diametro: '20' },
        fuentesJson: fuentes,
        confianza: 0.9,
      },
      {
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'boca',
        nombre: 'Toma 1',
        atributosJson: { tipo: 'toma', circuito: 'TUG1' },
        fuentesJson: fuentes,
        confianza: 0.9,
      },
    ]);

    const filas = await db.select().from(entidades).where(eq(entidades.obraId, obra.id));
    expect(filas.map((f) => f.tipo).sort()).toEqual(['accesorio', 'boca', 'tramo']);
  });

  it('acepta los cuatro rubros nuevos en computo_items', async () => {
    const { obra, lamina } = await sembrarObra();
    const fuentes: Fuente[] = [{ laminaId: lamina.id, bbox: [0, 0, 1, 1] }];
    const nuevos = ['terminaciones', 'sanitaria', 'electrica', 'demolicion'] as const;

    await db.insert(computoItems).values(
      nuevos.map((rubro) => ({
        obraId: obra.id,
        rubro,
        claveItem: `${rubro}.demo`,
        descripcion: `Ítem de ${rubro}`,
        unidad: 'u' as const,
        cantNeta: 1,
        desperdicioPct: 0,
        cantCompra: 1,
        presentacion: '1 u',
        origen: 'explicito' as const,
        fuentesJson: fuentes,
        confianza: 1,
      })),
    );

    const filas = await db.select().from(computoItems).where(eq(computoItems.obraId, obra.id));
    expect(filas.map((f) => f.rubro).sort()).toEqual([...nuevos].sort());
  });

  it("acepta las reglas 'cruce' y 'medicion_grafica' en deducciones", async () => {
    const { obra, lamina } = await sembrarObra();
    const fuentes: Fuente[] = [{ laminaId: lamina.id, bbox: [0, 0, 1, 1] }];
    const [entidad] = await db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'tabique',
        nombre: 'T1',
        atributosJson: { largoM: 4 },
        fuentesJson: fuentes,
        confianza: 0.9,
      })
      .returning();

    await db.insert(deducciones).values([
      {
        obraId: obra.id,
        entidadId: entidad.id,
        campo: 'alturaM',
        regla: 'cruce',
        fuentesJson: fuentes,
        valorJson: { alturaM: 2.6 },
        confianza: 0.8,
      },
      {
        obraId: obra.id,
        entidadId: entidad.id,
        campo: 'largoM',
        regla: 'medicion_grafica',
        fuentesJson: fuentes,
        valorJson: { largoM: 7.43 },
        confianza: 0.5,
      },
    ]);

    const filas = await db.select().from(deducciones).where(eq(deducciones.obraId, obra.id));
    expect(filas.map((f) => f.regla).sort()).toEqual(['cruce', 'medicion_grafica']);
  });
});

describe('migración sobre datos de F0', () => {
  it('la cadena F0 se sigue insertando igual, con las columnas nuevas en su default', async () => {
    const { obra, lamina } = await sembrarObra();
    const fuentes: Fuente[] = [{ laminaId: lamina.id, bbox: [0.1, 0.2, 0.3, 0.4] }];

    // Una entidad como las escribía F0: sin `elemento_id`.
    const [entidad] = await db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'tabique',
        nombre: 'T1',
        atributosJson: { largoM: 5, alturaM: 2.6, caras: 2, tipo: 'durlock' },
        estadoReforma: 'nueva',
        fuentesJson: fuentes,
        confianza: 0.75,
      })
      .returning();

    const [item] = await db
      .insert(computoItems)
      .values({
        obraId: obra.id,
        rubro: 'seco',
        entidadId: entidad.id,
        claveItem: 'seco.placas',
        descripcion: 'Placa de yeso 12,5 mm',
        unidad: 'm2',
        cantNeta: 26,
        desperdicioPct: 12,
        cantCompra: 31.68,
        presentacion: 'placa 1,20 × 2,40 m (2,88 m²)',
        origen: 'deducido',
        fuentesJson: fuentes,
        confianza: 0.75,
      })
      .returning();

    const [hallazgo] = await db
      .insert(hallazgos)
      .values({
        obraId: obra.id,
        clave: 'seco.altura_tabiques.T1',
        tipo: 'faltante',
        rubro: 'seco',
        descripcion: 'No pude leer la altura del tabique T1.',
        laminasJson: fuentes,
        bloqueante: true,
      })
      .returning();

    // Nada de lo viejo cambió…
    expect(item.cantCompra).toBe(31.68);
    expect(item.estado).toBe('activo');
    expect(hallazgo.estado).toBe('abierto');
    // …y las cuatro columnas nuevas nacen vacías.
    expect(entidad.elementoId).toBeNull();
    expect(item.precioJson).toBeNull();
    expect(hallazgo.targetDato).toBeNull();
    expect(obra.analisisJson).toBeNull();

    // Y la obra de F0 convive con lo nuevo: se le puede colgar un dato de obra.
    const [dato] = await db
      .insert(datosObra)
      .values({
        obraId: obra.id,
        clave: 'altura_local.general',
        valorJson: ALTURA_PB,
        origen: 'explicito',
        fuentesJson: fuentes,
        confianza: 1,
      })
      .returning();
    expect(dato.obraId).toBe(obra.id);
  });
});
