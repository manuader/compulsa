/**
 * Esquema de F1–F4 sobre PGlite en memoria: la cadena de la compulsa, las
 * unicidades nuevas y —lo que más importa— que la migración `0001` se pose sobre
 * una base con datos de F0 sin romper nada.
 *
 * `createTestDb()` corre TODAS las migraciones, así que "migrar no destruye" se
 * verifica por sus dos consecuencias observables: la cadena F0 completa
 * (estudio → obra → documento → lámina → ítems → hallazgos) sigue insertándose y
 * leyéndose igual que antes, con las columnas nuevas en su default; y las tablas
 * nuevas conviven con ella. El `ALTER TYPE … ADD VALUE 'cota'` y el índice único
 * parcial se ejercitan acá abajo, contra la base ya migrada.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  adjudicaciones,
  checklistsEstudio,
  compulsas,
  computoItems,
  conciliacionItems,
  contactosCompulsa,
  cotizaciones,
  deducciones,
  documentos,
  entidades,
  estudios,
  hallazgos,
  invitaciones,
  laminas,
  mensajes,
  negociaciones,
  notificaciones,
  obras,
  priceIndex,
  proveedores,
  recomputos,
  usuarios,
} from '@/db/schema';
import type { AnalysisProvider } from '@/lib/analysis/index';
import {
  procesarDocumento,
  procesarLamina,
  subirDocumento,
  TTL_PROCESANDO_MS,
} from '@/lib/pipeline/procesar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';
import {
  CONFIG_ESTUDIO_DEFAULT,
  zConfigEstudio,
  zCondicionesRfq,
  zItemRfq,
  zLineaPresupuesto,
  zMandato,
  type CondicionesRfq,
  type Fuente,
  type ItemRfq,
  type LineaPresupuesto,
  type Mandato,
} from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

/** Igual que en `db.test.ts`: el detalle de Postgres viaja en `cause`. */
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
  const [estudio] = await db.insert(estudios).values({ nombre: 'Estudio Norte' }).returning();
  const [usuario] = await db
    .insert(usuarios)
    .values({
      estudioId: estudio.id,
      email: 'ana@estudionorte.ar',
      nombre: 'Ana Beltrán',
      passwordHash: 'scrypt$no-usado-en-este-test',
      rol: 'titular',
    })
    .returning();
  const [obra] = await db
    .insert(obras)
    .values({ estudioId: estudio.id, nombre: 'Casa Belgrano', zona: 'CABA', tipo: 'reforma' })
    .returning();
  return { estudio, usuario, obra };
}

const ITEMS_RFQ: ItemRfq[] = [
  {
    claveItem: 'aberturas.V2',
    descripcion: 'Ventana corrediza de aluminio 1,50 × 1,20 m',
    unidad: 'u',
    cantidad: 4,
    presentacion: 'unidad',
    specsCriticas: { vidrio: 'DVH' },
  },
  {
    claveItem: 'seco.placas',
    descripcion: 'Placa de yeso 12,5 mm',
    unidad: 'm2',
    cantidad: 31.68,
    presentacion: 'placa 1,20 × 2,40 m (2,88 m²)',
    specsCriticas: {},
  },
];

const CONDICIONES: CondicionesRfq = {
  ivaDiscriminado: true,
  separarManoObraMateriales: true,
  validezMinimaDias: 7,
  plazoEntregaDias: 30,
  notas: null,
};

const MANDATO: Mandato = {
  objetivoMejoraPct: 5,
  palancas: ['volumen', 'adjudicacion_inmediata'],
  maxRondas: 2,
};

const LINEAS: LineaPresupuesto[] = [
  {
    descripcion: 'Ventana corrediza aluminio DVH 1,50x1,20',
    unidad: 'u',
    cantidad: 4,
    precioUnitario: 250_000,
    precioTotal: 1_000_000,
    claveItemSugerida: 'aberturas.V2',
    notas: null,
  },
];

/** Estudio + obra + un proveedor: el punto de partida de toda compulsa. */
async function sembrarCompulsa() {
  const { estudio, usuario, obra } = await sembrarObra();
  const [proveedor] = await db
    .insert(proveedores)
    .values({
      estudioId: estudio.id,
      nombre: 'Aberturas del Sur',
      rubros: ['aberturas'],
      zona: 'CABA',
      contactosJson: { telefono: '+54 11 4000-0000', email: 'ventas@aberturasdelsur.ar' },
      origen: 'agenda',
    })
    .returning();
  const [compulsa] = await db
    .insert(compulsas)
    .values({
      obraId: obra.id,
      rubro: 'aberturas',
      snapshotHash: 'a'.repeat(64),
      itemsJson: ITEMS_RFQ,
      condicionesJson: CONDICIONES,
      mandatoJson: MANDATO,
      aprobadoPor: usuario.id,
    })
    .returning();
  return { estudio, usuario, obra, proveedor, compulsa };
}

describe('cadena compulsa → contacto → cotización → conciliación → adjudicación', () => {
  it('persiste la cadena completa y la lee de vuelta por sus FKs', async () => {
    const { usuario, proveedor, compulsa } = await sembrarCompulsa();

    // El snapshot congela ítems y condiciones (RF-701).
    expect(compulsa.estado).toBe('borrador');
    expect(compulsa.version).toBe(1);
    expect(compulsa.itemsJson).toEqual(ITEMS_RFQ);
    expect(compulsa.condicionesJson).toEqual(CONDICIONES);
    expect(compulsa.mandatoJson).toEqual(MANDATO);
    expect(compulsa.aprobadoPor).toBe(usuario.id);

    const [contacto] = await db
      .insert(contactosCompulsa)
      .values({ compulsaId: compulsa.id, proveedorId: proveedor.id })
      .returning();
    expect(contacto.canal).toBe('manual');
    expect(contacto.estado).toBe('pendiente');

    const [mensaje] = await db
      .insert(mensajes)
      .values({
        contactoId: contacto.id,
        direccion: 'saliente',
        canal: 'manual',
        cuerpo: 'Hola, te paso el pedido de cotización de Casa Belgrano.',
        registradoPor: usuario.id,
      })
      .returning();
    expect(mensaje.direccion).toBe('saliente');
    expect(mensaje.at).toBeInstanceOf(Date);

    const [cotizacion] = await db
      .insert(cotizaciones)
      .values({
        contactoId: contacto.id,
        incluyeIva: false,
        validezDias: 10,
        plazoDias: 25,
        formaPago: '50% anticipo, 50% contra entrega',
        total: 1_000_000,
        lineasJson: LINEAS,
        rawTexto: 'Ventana corrediza aluminio DVH 1,50x1,20 — 4 u — $250.000 c/u',
        scoreFidelidad: 0.8,
      })
      .returning();
    expect(cotizacion.moneda).toBe('ARS');
    expect(cotizacion.estado).toBe('recibida');
    expect(cotizacion.total).toBe(1_000_000);
    expect(cotizacion.scoreFidelidad).toBe(0.8);
    expect(cotizacion.lineasJson).toEqual(LINEAS);
    expect(cotizacion.rawRef).toBeNull();

    const [conciliacion] = await db
      .insert(conciliacionItems)
      .values({
        cotizacionId: cotizacion.id,
        claveItem: 'aberturas.V2',
        lineaIdx: 0,
        match: 'exacto',
        desvioJson: { cantidadPct: 0 },
      })
      .returning();
    expect(conciliacion.match).toBe('exacto');
    expect(conciliacion.desvioJson).toEqual({ cantidadPct: 0 });

    // El ítem que el proveedor no cotizó también deja rastro.
    await db.insert(conciliacionItems).values({
      cotizacionId: cotizacion.id,
      claveItem: 'seco.placas',
      lineaIdx: null,
      match: 'no_cotizado',
      nota: 'No aparece en el presupuesto.',
    });

    const [negociacion] = await db
      .insert(negociaciones)
      .values({
        cotizacionId: cotizacion.id,
        ronda: 1,
        ofertaJson: { total: 950_000, palanca: 'volumen' },
      })
      .returning();
    expect(negociacion.resultado).toBe('pendiente');
    expect(negociacion.logJson).toBeNull();

    const [adjudicacion] = await db
      .insert(adjudicaciones)
      .values({
        compulsaId: compulsa.id,
        cotizacionId: cotizacion.id,
        ocTexto: 'OC 0001 — Aberturas del Sur — $950.000 + IVA',
      })
      .returning();
    expect(adjudicacion.confirmadoAt).toBeNull();

    // Lectura de vuelta: la cadena entera por FKs, de la adjudicación a la obra.
    const [fila] = await db
      .select({
        obraNombre: obras.nombre,
        compulsaRubro: compulsas.rubro,
        compulsaHash: compulsas.snapshotHash,
        proveedorNombre: proveedores.nombre,
        proveedorRubros: proveedores.rubros,
        contactoEstado: contactosCompulsa.estado,
        cotizacionTotal: cotizaciones.total,
        cotizacionFidelidad: cotizaciones.scoreFidelidad,
        ocTexto: adjudicaciones.ocTexto,
      })
      .from(adjudicaciones)
      .innerJoin(cotizaciones, eq(adjudicaciones.cotizacionId, cotizaciones.id))
      .innerJoin(contactosCompulsa, eq(cotizaciones.contactoId, contactosCompulsa.id))
      .innerJoin(proveedores, eq(contactosCompulsa.proveedorId, proveedores.id))
      .innerJoin(compulsas, eq(adjudicaciones.compulsaId, compulsas.id))
      .innerJoin(obras, eq(compulsas.obraId, obras.id))
      .where(eq(adjudicaciones.id, adjudicacion.id));

    expect(fila.obraNombre).toBe('Casa Belgrano');
    expect(fila.compulsaRubro).toBe('aberturas');
    expect(fila.compulsaHash).toBe('a'.repeat(64));
    expect(fila.proveedorNombre).toBe('Aberturas del Sur');
    expect(fila.proveedorRubros).toEqual(['aberturas']);
    expect(fila.contactoEstado).toBe('pendiente');
    expect(fila.cotizacionTotal).toBe(1_000_000);
    expect(fila.cotizacionFidelidad).toBe(0.8);
    expect(fila.ocTexto).toBe('OC 0001 — Aberturas del Sur — $950.000 + IVA');

    // Las dos conciliaciones (la exacta y la no cotizada) cuelgan de la cotización.
    const conciliadas = await db
      .select()
      .from(conciliacionItems)
      .where(eq(conciliacionItems.cotizacionId, cotizacion.id));
    expect(conciliadas.map((c) => c.match).sort()).toEqual(['exacto', 'no_cotizado']);
  });

  it('aplica los defaults del proveedor: sin opt-in, sin opt-out, sin score', async () => {
    const { estudio } = await sembrarObra();
    const [proveedor] = await db
      .insert(proveedores)
      .values({
        estudioId: estudio.id,
        nombre: 'Corralón Belgrano',
        rubros: ['gruesa', 'seco'],
        zona: 'Zona Norte',
        origen: 'manual',
      })
      .returning();

    // Compliance §13: nadie recibe un WhatsApp sin opt-in registrado.
    expect(proveedor.optInWa).toBe(false);
    expect(proveedor.optInRegistradoEn).toBeNull();
    expect(proveedor.optOut).toBe(false);
    expect(proveedor.score).toBeNull();
    expect(proveedor.contactosJson).toEqual({});
    expect(proveedor.rubros).toEqual(['gruesa', 'seco']);
  });
});

describe('unicidades de F1–F4', () => {
  it('rechaza contactar dos veces al mismo proveedor en la misma compulsa', async () => {
    const { proveedor, compulsa } = await sembrarCompulsa();
    const valores = { compulsaId: compulsa.id, proveedorId: proveedor.id };

    await db.insert(contactosCompulsa).values(valores);
    expect(await violacionUnica(db.insert(contactosCompulsa).values(valores))).toBe(
      'contactos_compulsa_compulsa_proveedor_uq',
    );
  });

  it('rechaza dos conciliaciones para la misma clave de ítem, pero deja repetir los extras', async () => {
    const { proveedor, compulsa } = await sembrarCompulsa();
    const [contacto] = await db
      .insert(contactosCompulsa)
      .values({ compulsaId: compulsa.id, proveedorId: proveedor.id })
      .returning();
    const [cotizacion] = await db
      .insert(cotizaciones)
      .values({ contactoId: contacto.id, incluyeIva: true, lineasJson: LINEAS })
      .returning();

    await db.insert(conciliacionItems).values({
      cotizacionId: cotizacion.id,
      claveItem: 'aberturas.V2',
      lineaIdx: 0,
      match: 'exacto',
    });
    expect(
      await violacionUnica(
        db.insert(conciliacionItems).values({
          cotizacionId: cotizacion.id,
          claveItem: 'aberturas.V2',
          lineaIdx: 1,
          match: 'parcial',
        }),
      ),
    ).toBe('conciliacion_items_cotizacion_clave_uq');

    // Las líneas `extra` no tienen clave del RFQ: van con `clave_item` NULL y en
    // Postgres los NULL no chocan entre sí, así que pueden ser varias.
    await db.insert(conciliacionItems).values([
      { cotizacionId: cotizacion.id, claveItem: null, lineaIdx: 2, match: 'extra' },
      { cotizacionId: cotizacion.id, claveItem: null, lineaIdx: 3, match: 'extra' },
    ]);
    const extras = await db
      .select()
      .from(conciliacionItems)
      .where(and(eq(conciliacionItems.cotizacionId, cotizacion.id), eq(conciliacionItems.match, 'extra')));
    expect(extras).toHaveLength(2);
  });

  it('rechaza adjudicar dos veces la misma compulsa', async () => {
    const { proveedor, compulsa } = await sembrarCompulsa();
    const [contacto] = await db
      .insert(contactosCompulsa)
      .values({ compulsaId: compulsa.id, proveedorId: proveedor.id })
      .returning();
    const [cotizacion] = await db
      .insert(cotizaciones)
      .values({ contactoId: contacto.id, incluyeIva: true, lineasJson: LINEAS })
      .returning();

    await db
      .insert(adjudicaciones)
      .values({ compulsaId: compulsa.id, cotizacionId: cotizacion.id, ocTexto: 'OC 1' });
    expect(
      await violacionUnica(
        db
          .insert(adjudicaciones)
          .values({ compulsaId: compulsa.id, cotizacionId: cotizacion.id, ocTexto: 'OC 2' }),
      ),
    ).toBe('adjudicaciones_compulsa_uq');
  });

  it('rechaza dos renglones de price_index para (estudio, clave, zona, mes)', async () => {
    const { estudio } = await sembrarObra();
    const base = {
      estudioId: estudio.id,
      claveItem: 'seco.placas',
      zona: 'CABA',
      mes: '2026-08',
      p25: 20,
      p50: 30,
      p75: 40,
      n: 5,
      muestrasJson: [10, 20, 30, 40, 50],
    };

    const [fila] = await db.insert(priceIndex).values(base).returning();
    // Nearest-rank sobre [10,20,30,40,50] (RF-1103): la serie se guarda entera
    // porque agregar una muestra obliga a recalcular los tres percentiles.
    expect(fila.muestrasJson).toEqual([10, 20, 30, 40, 50]);
    expect([fila.p25, fila.p50, fila.p75]).toEqual([20, 30, 40]);
    expect(fila.n).toBe(5);

    expect(await violacionUnica(db.insert(priceIndex).values(base))).toBe(
      'price_index_estudio_clave_zona_mes_uq',
    );

    // Otro mes es otro renglón.
    await db.insert(priceIndex).values({ ...base, mes: '2026-09' });
    expect(await db.select().from(priceIndex)).toHaveLength(2);
  });

  it('rechaza dos deducciones para el mismo (obra, entidad, campo)', async () => {
    const { usuario, obra } = await sembrarObra();
    const [documento] = await db
      .insert(documentos)
      .values({
        obraId: obra.id,
        nombreArchivo: 'planta.pdf',
        tipo: 'plano',
        archivoRef: 'obras/x/planta.pdf',
        mime: 'application/pdf',
        hash: 'ab12',
        subidoPor: usuario.id,
      })
      .returning();
    const [lamina] = await db
      .insert(laminas)
      .values({
        documentoId: documento.id,
        obraId: obra.id,
        numeroPagina: 1,
        archivoRef: 'obras/x/planta-p1.pdf',
      })
      .returning();
    const [entidad] = await db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'tabique',
        nombre: 'T1',
        atributosJson: { largoM: 5 },
        fuentesJson: [{ laminaId: lamina.id, bbox: [0, 0, 0.5, 0.5] }],
        confianza: 0.8,
      })
      .returning();

    const fuentes: Fuente[] = [
      { laminaId: lamina.id, bbox: [0, 0, 0.5, 0.5], detalle: 'planta' },
      { laminaId: lamina.id, bbox: [0.5, 0, 0.5, 0.5], detalle: 'corte A-A' },
    ];
    const base = {
      obraId: obra.id,
      entidadId: entidad.id,
      campo: 'alturaM',
      regla: 'planta_corte' as const,
      fuentesJson: fuentes,
      valorJson: { alturaM: 2.6 },
      confianza: 0.85,
    };

    const [deduccion] = await db.insert(deducciones).values(base).returning();
    expect(deduccion.estado).toBe('propuesta');
    expect(deduccion.validadoPor).toBeNull();
    // §11: toda deducción con ≥ 2 fuentes y confianza ≥ 0,7.
    expect(deduccion.fuentesJson).toHaveLength(2);
    expect(deduccion.valorJson).toEqual({ alturaM: 2.6 });

    expect(await violacionUnica(db.insert(deducciones).values(base))).toBe(
      'deducciones_obra_entidad_campo_uq',
    );

    // Otro campo de la misma entidad sí entra.
    await db.insert(deducciones).values({ ...base, campo: 'espesorM', valorJson: { espesorM: 0.1 } });
    expect(await db.select().from(deducciones)).toHaveLength(2);
  });

  it('rechaza dos ítems de checklist con el mismo (estudio, rubro, item)', async () => {
    const { estudio } = await sembrarObra();
    const base = {
      estudioId: estudio.id,
      rubro: 'aberturas' as const,
      itemId: 'premarco',
      descripcion: '¿Lleva premarco?',
    };

    const [item] = await db.insert(checklistsEstudio).values(base).returning();
    expect(item.bloqueante).toBe(false);
    expect(item.activo).toBe(true);

    expect(await violacionUnica(db.insert(checklistsEstudio).values(base))).toBe(
      'checklists_estudio_estudio_rubro_item_uq',
    );
  });
});

describe('plataforma: invitaciones, recómputos y notificaciones', () => {
  it('guarda una invitación con su rol y la marca usada', async () => {
    const { estudio, usuario } = await sembrarObra();
    const expira = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [invitacion] = await db
      .insert(invitaciones)
      .values({ codigo: 'inv-abc123', estudioId: estudio.id, rol: 'colaborador', expiraAt: expira })
      .returning();
    expect(invitacion.rol).toBe('colaborador');
    expect(invitacion.usadaPor).toBeNull();

    await db
      .update(invitaciones)
      .set({ usadaPor: usuario.id })
      .where(eq(invitaciones.codigo, 'inv-abc123'));
    const [usada] = await db
      .select()
      .from(invitaciones)
      .where(eq(invitaciones.codigo, 'inv-abc123'));
    expect(usada.usadaPor).toBe(usuario.id);
  });

  it('guarda el diff de una corrida de recompute y una notificación sin leer', async () => {
    const { usuario, obra } = await sembrarObra();

    const [recomputo] = await db
      .insert(recomputos)
      .values({
        obraId: obra.id,
        diffJson: { 'seco.placas': { antes: 28.8, despues: 31.68 } },
        motivo: 'Se validó la altura del tabique T1.',
      })
      .returning();
    expect(recomputo.at).toBeInstanceOf(Date);
    expect(recomputo.diffJson).toEqual({ 'seco.placas': { antes: 28.8, despues: 31.68 } });

    const [notificacion] = await db
      .insert(notificaciones)
      .values({
        usuarioId: usuario.id,
        titulo: 'Llegó una cotización',
        cuerpo: 'Aberturas del Sur cotizó la compulsa de aberturas.',
        link: `/obras/${obra.id}/comparativa`,
      })
      .returning();
    expect(notificacion.leida).toBe(false);
  });

  it('da de alta al usuario activo y permite la baja lógica', async () => {
    const { estudio, usuario } = await sembrarObra();
    expect(usuario.activo).toBe(true);

    await db.update(usuarios).set({ activo: false }).where(eq(usuarios.id, usuario.id));
    const activos = await db
      .select()
      .from(usuarios)
      .where(and(eq(usuarios.estudioId, estudio.id), eq(usuarios.activo, true)));
    expect(activos).toHaveLength(0);
  });
});

describe('migración sobre datos de F0', () => {
  it('la cadena F0 sigue insertándose y leyéndose, con las columnas nuevas en su default', async () => {
    const { usuario, obra } = await sembrarObra();

    // `obras.resumen_json` es nuevo y nace nulo: una obra de F0 no lo tenía.
    expect(obra.resumenJson).toBeNull();
    const [estudioFila] = await db.select().from(estudios).where(eq(estudios.id, obra.estudioId));
    expect(estudioFila.configJson).toEqual({});

    const [documento] = await db
      .insert(documentos)
      .values({
        obraId: obra.id,
        nombreArchivo: 'obra-demo.pdf',
        tipo: 'plano',
        archivoRef: `obras/${obra.id}/documentos/obra-demo.pdf`,
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
        disciplina: 'arquitectura',
        tipo: 'planta',
        escala: '1:100',
        escalaConfiable: true,
        archivoRef: `obras/${obra.id}/laminas/${documento.id}-p1.pdf`,
      })
      .returning();

    // Las dos columnas nuevas de `laminas` no rompen a quien inserta como en F0.
    expect(lamina.textoExtraido).toBeNull();
    expect(lamina.procesandoDesde).toBeNull();
    expect(lamina.estadoAnalisis).toBe('pendiente');

    const fuentes: Fuente[] = [{ laminaId: lamina.id, bbox: [0.1, 0.2, 0.3, 0.4] }];
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

    expect(item.cantCompra).toBe(31.68);
    expect(item.estado).toBe('activo');
    expect(item.fuentesJson).toEqual(fuentes);
    expect(hallazgo.estado).toBe('abierto');

    // Y la obra de F0 convive con lo nuevo: se le puede colgar una compulsa.
    const [compulsa] = await db
      .insert(compulsas)
      .values({
        obraId: obra.id,
        rubro: 'seco',
        snapshotHash: 'b'.repeat(64),
        itemsJson: ITEMS_RFQ,
        condicionesJson: CONDICIONES,
      })
      .returning();
    expect(compulsa.mandatoJson).toBeNull();
    expect(compulsa.obraId).toBe(obra.id);
  });

  it("acepta el tipo de entidad 'cota' que agregó el ALTER TYPE", async () => {
    const { usuario, obra } = await sembrarObra();
    const [documento] = await db
      .insert(documentos)
      .values({
        obraId: obra.id,
        nombreArchivo: 'planta.pdf',
        tipo: 'plano',
        archivoRef: 'obras/x/planta.pdf',
        mime: 'application/pdf',
        hash: 'cd34',
        subidoPor: usuario.id,
      })
      .returning();
    const [lamina] = await db
      .insert(laminas)
      .values({
        documentoId: documento.id,
        obraId: obra.id,
        numeroPagina: 1,
        archivoRef: 'obras/x/planta-p1.pdf',
      })
      .returning();

    // `cierre_cotas` (§11): las cotas son entidades con `valorM`, `sobre` y `tramo`.
    const [cota] = await db
      .insert(entidades)
      .values({
        obraId: obra.id,
        laminaId: lamina.id,
        tipo: 'cota',
        nombre: 'Cota fachada norte',
        atributosJson: { valorM: 12.4, sobre: 'fachada-norte', tramo: 'total' },
        fuentesJson: [{ laminaId: lamina.id, bbox: [0, 0.9, 1, 0.05] }],
        confianza: 0.9,
      })
      .returning();

    expect(cota.tipo).toBe('cota');
    expect(cota.atributosJson).toEqual({ valorM: 12.4, sobre: 'fachada-norte', tramo: 'total' });

    const cotas = await db
      .select()
      .from(entidades)
      .where(and(eq(entidades.obraId, obra.id), eq(entidades.tipo, 'cota')));
    expect(cotas).toHaveLength(1);
  });
});

describe('índice único parcial de computo_items', () => {
  async function insertarItem(obraId: string, claveItem: string, estado: 'activo' | 'anulado') {
    return db
      .insert(computoItems)
      .values({
        obraId,
        rubro: 'seco',
        claveItem,
        descripcion: 'Placa de yeso 12,5 mm',
        unidad: 'm2',
        cantNeta: 26,
        desperdicioPct: 12,
        cantCompra: 31.68,
        presentacion: 'placa 1,20 × 2,40 m (2,88 m²)',
        origen: 'deducido',
        fuentesJson: [],
        confianza: 0.75,
        estado,
      })
      .returning();
  }

  it('rechaza dos ítems activos con la misma clave en la misma obra', async () => {
    const { obra } = await sembrarObra();
    await insertarItem(obra.id, 'seco.placas', 'activo');

    expect(await violacionUnica(insertarItem(obra.id, 'seco.placas', 'activo'))).toBe(
      'computo_items_obra_clave_activo_uq',
    );
  });

  it('deja repetir la clave entre anulados: son el historial, no la planilla', async () => {
    const { obra } = await sembrarObra();

    await insertarItem(obra.id, 'seco.placas', 'anulado');
    await insertarItem(obra.id, 'seco.placas', 'anulado');
    const [vivo] = await insertarItem(obra.id, 'seco.placas', 'activo');

    const filas = await db
      .select()
      .from(computoItems)
      .where(eq(computoItems.claveItem, 'seco.placas'));
    expect(filas).toHaveLength(3);
    expect(filas.filter((f) => f.estado === 'activo')).toHaveLength(1);

    // Y anular el vivo libera la clave para uno nuevo (lo que hace el recompute).
    await db.update(computoItems).set({ estado: 'anulado' }).where(eq(computoItems.id, vivo.id));
    await insertarItem(obra.id, 'seco.placas', 'activo');
    const despues = await db
      .select()
      .from(computoItems)
      .where(and(eq(computoItems.claveItem, 'seco.placas'), eq(computoItems.estado, 'activo')));
    expect(despues).toHaveLength(1);
  });

  it('no molesta a la misma clave en otra obra', async () => {
    const { estudio, obra } = await sembrarObra();
    const [otra] = await db
      .insert(obras)
      .values({ estudioId: estudio.id, nombre: 'Casa Núñez', zona: 'CABA', tipo: 'nueva' })
      .returning();

    await insertarItem(obra.id, 'seco.placas', 'activo');
    await insertarItem(otra.id, 'seco.placas', 'activo');

    expect(
      await db.select().from(computoItems).where(eq(computoItems.estado, 'activo')),
    ).toHaveLength(2);
  });
});

describe('laminas.procesando_desde es el reloj del rescate por TTL', () => {
  const PDFS = new URL('../fixtures/pdfs/', import.meta.url);
  let raizStorage: string;
  let storage: StorageAdapter;

  beforeEach(async () => {
    raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-p1-'));
    storage = crearStorageLocal(raizStorage);
  });

  afterEach(async () => {
    await rm(raizStorage, { recursive: true, force: true });
  });

  /** Anota qué veía la fila de la lámina en el momento en que el provider corrió. */
  function providerObservador(visto: Array<{ estado: string; procesandoDesde: Date | null }>) {
    const provider: AnalysisProvider = {
      async leerRotulo(entrada) {
        const [fila] = await db.select().from(laminas).where(eq(laminas.id, entrada.laminaId));
        visto.push({ estado: fila.estadoAnalisis, procesandoDesde: fila.procesandoDesde });
        return {
          titulo: 'Planta baja',
          codigo: 'A-01',
          disciplina: 'arquitectura',
          tipoLamina: 'planta',
          escala: '1:100',
          escalaConfiable: true,
          revision: null,
          confianza: 1,
        };
      },
      async extraerEntidades() {
        return [];
      },
    };
    return provider;
  }

  async function subirUnaLamina() {
    const { usuario, obra } = await sembrarObra();
    const bytes = await readFile(new URL('obra-demo.pdf', PDFS));
    const archivo = new File([new Uint8Array(bytes)], 'obra-demo.pdf', {
      type: 'application/pdf',
    });
    const documento = await subirDocumento(db, storage, obra.id, usuario.id, archivo);
    return { obra, documento };
  }

  it('se sella al reclamar la lámina y se limpia al terminar', async () => {
    const { documento } = await subirUnaLamina();
    const visto: Array<{ estado: string; procesandoDesde: Date | null }> = [];

    const antes = Date.now();
    await procesarDocumento(documento.id, {
      db,
      storage,
      provider: providerObservador(visto),
      recomputar: async () => undefined,
    });

    // Mientras el análisis corría, la fila decía quién la tenía y desde cuándo.
    expect(visto.length).toBeGreaterThan(0);
    expect(visto[0].estado).toBe('procesando');
    expect(visto[0].procesandoDesde).toBeInstanceOf(Date);
    expect(visto[0].procesandoDesde!.getTime()).toBeGreaterThanOrEqual(antes - 1000);

    // Y al terminar se suelta: `procesando_desde` no nulo significa "la tiene alguien".
    const filas = await db.select().from(laminas).where(eq(laminas.documentoId, documento.id));
    for (const fila of filas) {
      expect(fila.estadoAnalisis).toBe('analizada');
      expect(fila.procesandoDesde).toBeNull();
    }
  });

  it('retoma la lámina colgada mirando procesando_desde, sin ir a la auditoría', async () => {
    const { documento } = await subirUnaLamina();
    const visto: Array<{ estado: string; procesandoDesde: Date | null }> = [];
    await procesarDocumento(documento.id, {
      db,
      storage,
      provider: providerObservador(visto),
      recomputar: async () => undefined,
    });
    const [lamina] = await db.select().from(laminas).where(eq(laminas.documentoId, documento.id));

    // Un proceso la tomó hace más del TTL y murió. El sello está en la columna:
    // la auditoría no se toca, así que si el rescate siguiera leyendo de ahí
    // vería un arranque reciente y no la soltaría nunca.
    const colgadaDesde = new Date(Date.now() - TTL_PROCESANDO_MS - 60_000);
    await db
      .update(laminas)
      .set({ estadoAnalisis: 'procesando', procesandoDesde: colgadaDesde })
      .where(eq(laminas.id, lamina.id));

    const visto2: Array<{ estado: string; procesandoDesde: Date | null }> = [];
    await procesarLamina(lamina.id, {
      db,
      storage,
      provider: providerObservador(visto2),
      recomputar: async () => undefined,
    });

    expect(visto2).toHaveLength(1); // corrió: la retomó
    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.estadoAnalisis).toBe('analizada');
    expect(despues.procesandoDesde).toBeNull();
  });

  it('no le pisa la lámina a una corrida que la tomó recién', async () => {
    const { documento } = await subirUnaLamina();
    const visto: Array<{ estado: string; procesandoDesde: Date | null }> = [];
    await procesarDocumento(documento.id, {
      db,
      storage,
      provider: providerObservador(visto),
      recomputar: async () => undefined,
    });
    const [lamina] = await db.select().from(laminas).where(eq(laminas.documentoId, documento.id));

    await db
      .update(laminas)
      .set({ estadoAnalisis: 'procesando', procesandoDesde: new Date() })
      .where(eq(laminas.id, lamina.id));

    const visto2: Array<{ estado: string; procesandoDesde: Date | null }> = [];
    await procesarLamina(lamina.id, {
      db,
      storage,
      provider: providerObservador(visto2),
      recomputar: async () => undefined,
    });

    expect(visto2).toHaveLength(0); // no corrió: la otra corrida manda
    const [despues] = await db.select().from(laminas).where(eq(laminas.id, lamina.id));
    expect(despues.estadoAnalisis).toBe('procesando');
  });
});

describe('contratos zod de F1–F4', () => {
  it('zConfigEstudio rellena la configuración entera desde un config_json vacío', () => {
    expect(zConfigEstudio.parse({})).toEqual(CONFIG_ESTUDIO_DEFAULT);

    // Pesos del ranking (RF-1101) y validez mínima del PRD, pinneados.
    const config = zConfigEstudio.parse({});
    expect(config.pesosRanking).toEqual({ total: 0.5, fidelidad: 0.3, plazo: 0.2 });
    expect(config.condicionesDefault.validezMinimaDias).toBe(7);
    expect(config.condicionesDefault.ivaDiscriminado).toBe(true);
    expect(config.mandatoDefault.maxRondas).toBe(2);
    expect(config.mepReferencia).toBeNull();
  });

  it('zConfigEstudio deja pisar solo lo que el estudio cambió', () => {
    const config = zConfigEstudio.parse({
      desperdiciosPct: { 'seco.placas': 15 },
      mepReferencia: { valor: 1450.5, fecha: '2026-08-01' },
    });

    expect(config.desperdiciosPct).toEqual({ 'seco.placas': 15 });
    expect(config.mepReferencia).toEqual({ valor: 1450.5, fecha: '2026-08-01' });
    // Lo que no vino sigue siendo el default.
    expect(config.pesosRanking).toEqual({ total: 0.5, fidelidad: 0.3, plazo: 0.2 });
    expect(config.mandatoDefault.palancas).toEqual(['volumen', 'plazo_pago']);
  });

  it('zCondicionesRfq exige IVA discriminado siempre (PRD §13)', () => {
    expect(zCondicionesRfq.parse(CONDICIONES)).toEqual(CONDICIONES);
    expect(zCondicionesRfq.safeParse({ ...CONDICIONES, ivaDiscriminado: false }).success).toBe(
      false,
    );
  });

  it('zMandato fija las rondas en 2 y solo acepta las palancas del PRD', () => {
    expect(zMandato.parse(MANDATO)).toEqual(MANDATO);
    expect(zMandato.safeParse({ ...MANDATO, maxRondas: 3 }).success).toBe(false);
    expect(zMandato.safeParse({ ...MANDATO, palancas: ['descuento'] }).success).toBe(false);
  });

  it('zItemRfq y zLineaPresupuesto validan lo que va y viene del proveedor', () => {
    expect(zItemRfq.parse(ITEMS_RFQ[0])).toEqual(ITEMS_RFQ[0]);
    // La unidad tiene que ser una de las del dominio.
    expect(zItemRfq.safeParse({ ...ITEMS_RFQ[0], unidad: 'bolsa' }).success).toBe(false);

    expect(zLineaPresupuesto.parse(LINEAS[0])).toEqual(LINEAS[0]);
    // Un presupuesto ilegible llega con todo en null menos la descripción.
    const ilegible: LineaPresupuesto = {
      descripcion: 'Ver adjunto',
      unidad: null,
      cantidad: null,
      precioUnitario: null,
      precioTotal: null,
      claveItemSugerida: null,
      notas: 'No se pudo leer el detalle.',
    };
    expect(zLineaPresupuesto.parse(ilegible)).toEqual(ilegible);
    // `undefined` no es `null`: los campos opcionales no existen en este contrato.
    expect(zLineaPresupuesto.safeParse({ descripcion: 'x' }).success).toBe(false);
  });
});
