/**
 * Los núcleos de las pantallas de compulsa y conversaciones (P8).
 *
 * Lo que se prueba acá **no** es el flujo de `@/lib/compulsa/flujo` (eso lo
 * cubre `tests/integration/flujo-compulsa.test.ts`, de P5): son las piezas que
 * agregan estas pantallas y que, si se rompen, rompen la pantalla en silencio:
 *
 *  1. **Las refs de los recortes se sirven** por `/api/archivos/[...ref]` con la
 *     misma validación de pertenencia que un documento (RNF-4).
 *  2. **La selección de proveedores** del wizard: shortlist rankeada + los no
 *     contactables con su motivo a la vista (§13).
 *  3. **El aviso RF-701** de la pantalla de armado: ya hay compulsa vigente de
 *     ese rubro, y el cómputo cambió (o no).
 *  4. **El preview del presupuesto**: parsear sin persistir, con lo que el saneo
 *     descartaría a la vista y el score que va a quedar.
 *  5. **Cargar el total a mano** cuando el proveedor no lo declaró (P5 §8).
 *  6. **El estado del contacto a mano**, sin dejar que la pantalla mienta.
 *  7. **«Sin respuesta hace 7+ días»** como consulta, y su notificación al
 *     titular sin duplicar.
 *  8. **La notificación de cotización conciliada**, que P7 dejó declarada y sin
 *     productor.
 *
 * `next/headers` va mockeado igual que en `tests/integration/deducciones-rutas.test.ts`:
 * el handler de archivos lee la cookie de ahí y en un test no hay request de Next.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as GET_ARCHIVO } from '@/app/api/archivos/[...ref]/route';
import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  compulsas,
  computoItems,
  computoRubros,
  contactosCompulsa,
  cotizaciones,
  estudios,
  mensajes,
  notificaciones,
  obras,
  proveedores,
  usuarios,
  type Compulsa,
  type ContactoCompulsa,
  type Proveedor,
} from '@/db/schema';
import { crearSesion } from '@/lib/auth/session';
import { registrarCotizacion, type ActorCompulsa } from '@/lib/compulsa/flujo';
import { parsearRefArchivo } from '@/lib/pipeline/refs';
import { RAIZ_UPLOADS, crearStorageLocal } from '@/lib/storage/index';
import type { CondicionesRfq, ItemRfq, LineaPresupuesto } from '@/types/domain';

import {
  armarSeleccionProveedoresCore,
  cargarTotalCotizacionCore,
  detectarSinRespuestaCore,
  notificarCotizacionConciliadaCore,
  notificarSinRespuestaCore,
  previewRubroCore,
  previsualizarPresupuestoCore,
} from '@/app/obras/[obraId]/compulsas/actions';
import { cambiarEstadoContactoCore } from '@/app/obras/[obraId]/conversaciones/actions';

import { createTestDb } from '../helpers/test-db';

/** Cookie que ve el handler en la llamada que viene. `undefined` ⇒ sin sesión. */
let cookieActual: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      cookieActual && nombre === 'compulsa_session' ? { value: cookieActual } : undefined,
  }),
}));

const AHORA = new Date('2026-08-26T15:00:00Z');

const CONDICIONES: CondicionesRfq = {
  ivaDiscriminado: true,
  separarManoObraMateriales: true,
  validezMinimaDias: 7,
  plazoEntregaDias: null,
  notas: null,
};

const ITEM_PLACAS: ItemRfq = {
  claveItem: 'seco.placas',
  descripcion: 'Placa de roca de yeso 12,5 mm para tabique de durlock',
  unidad: 'm2',
  cantidad: 31.68,
  presentacion: '11 placas de 1,20 × 2,40 m',
  specsCriticas: { tipo: 'durlock' },
};

const ITEM_MASILLA: ItemRfq = {
  claveItem: 'seco.masilla',
  descripcion: 'Masilla lista para juntas',
  unidad: 'kg',
  cantidad: 30,
  presentacion: 'baldes de 30 kg',
  specsCriticas: {},
};

let db: Db;
let estudioId: string;
let otroEstudioId: string;
let obraId: string;
let obraAjenaId: string;
let titular: ActorCompulsa;
let colaborador: ActorCompulsa;
let mirona: ActorCompulsa;
let ajeno: ActorCompulsa;
let token: string;
let corralon: Proveedor;
let ferreteria: Proveedor;
let noContactar: Proveedor;
let deOtroRubro: Proveedor;

const estudiosCreados: string[] = [];

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  cookieActual = undefined;

  const [norte, sur] = await db
    .insert(estudios)
    .values([{ nombre: 'Estudio Norte' }, { nombre: 'Estudio Sur' }])
    .returning();
  estudioId = norte.id;
  otroEstudioId = sur.id;
  estudiosCreados.push(norte.id, sur.id);

  const [jefa, pasante, mira, ajena] = await db
    .insert(usuarios)
    .values([
      { estudioId: norte.id, email: 'ana@norte.ar', nombre: 'Ana', passwordHash: 'x', rol: 'titular' },
      { estudioId: norte.id, email: 'beto@norte.ar', nombre: 'Beto', passwordHash: 'x', rol: 'colaborador' },
      { estudioId: norte.id, email: 'cata@norte.ar', nombre: 'Cata', passwordHash: 'x', rol: 'lectura' },
      { estudioId: sur.id, email: 'sur@sur.ar', nombre: 'Sur', passwordHash: 'x', rol: 'titular' },
    ])
    .returning();

  titular = { usuarioId: jefa.id, email: jefa.email, rol: 'titular', estudioId: norte.id };
  colaborador = { usuarioId: pasante.id, email: pasante.email, rol: 'colaborador', estudioId: norte.id };
  mirona = { usuarioId: mira.id, email: mira.email, rol: 'lectura', estudioId: norte.id };
  ajeno = { usuarioId: ajena.id, email: ajena.email, rol: 'titular', estudioId: sur.id };

  const [obra, ajenaObra] = await db
    .insert(obras)
    .values([
      { estudioId: norte.id, nombre: 'Casa Demo', zona: 'Vicente López', tipo: 'nueva' },
      { estudioId: sur.id, nombre: 'Ajena', zona: 'CABA', tipo: 'nueva' },
    ])
    .returning();
  obraId = obra.id;
  obraAjenaId = ajenaObra.id;

  [corralon, ferreteria, noContactar, deOtroRubro] = await db
    .insert(proveedores)
    .values([
      {
        estudioId: norte.id,
        nombre: 'Corralón San Martín',
        rubros: ['seco'],
        zona: 'Vicente López',
        origen: 'manual',
        optInWa: true,
        optInRegistradoEn: AHORA,
        score: 0.9,
      },
      {
        estudioId: norte.id,
        nombre: 'Ferretería del Centro',
        rubros: ['seco'],
        zona: 'Vicente López',
        origen: 'manual',
      },
      {
        estudioId: norte.id,
        nombre: 'Corralón que no quiere',
        rubros: ['seco'],
        zona: 'Vicente López',
        origen: 'manual',
        optOut: true,
      },
      {
        estudioId: norte.id,
        nombre: 'Vidriería del Puerto',
        rubros: ['aberturas'],
        zona: 'CABA',
        origen: 'manual',
      },
    ])
    .returning();

  token = (await crearSesion(db, jefa.id)).token;
});

afterAll(async () => {
  // El handler de archivos usa `getStorage()`, que escribe bajo `data/uploads/`
  // del worktree (no hay inyección). Se limpia lo que se escribió, nada más.
  for (const id of estudiosCreados) {
    await rm(path.join(RAIZ_UPLOADS, 'estudios', id), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers de armado
// ---------------------------------------------------------------------------

/** Deja el rubro seco aprobado con dos ítems, sin correr el pipeline. */
async function aprobarSecoConDosItems(): Promise<void> {
  await db.insert(computoItems).values([
    {
      obraId,
      rubro: 'seco',
      claveItem: 'seco.placas',
      descripcion: ITEM_PLACAS.descripcion,
      unidad: 'm2',
      cantNeta: 28.11,
      desperdicioPct: 12,
      cantCompra: 31.68,
      presentacion: ITEM_PLACAS.presentacion,
      origen: 'explicito',
      fuentesJson: [],
      confianza: 0.9,
    },
    {
      obraId,
      rubro: 'seco',
      claveItem: 'seco.masilla',
      descripcion: ITEM_MASILLA.descripcion,
      unidad: 'kg',
      cantNeta: 30,
      desperdicioPct: 0,
      cantCompra: 30,
      presentacion: ITEM_MASILLA.presentacion,
      origen: 'explicito',
      fuentesJson: [],
      confianza: 0.9,
    },
  ]);
  await db.insert(computoRubros).values({
    obraId,
    rubro: 'seco',
    estado: 'aprobado',
    aprobadoPor: titular.usuarioId,
    aprobadoAt: AHORA,
  });
}

/** Una compulsa lanzada a mano, con su contacto, sin pasar por el core de P5. */
async function compulsaConContacto(
  itemsRfq: ItemRfq[] = [ITEM_PLACAS, ITEM_MASILLA],
): Promise<{ compulsa: Compulsa; contacto: ContactoCompulsa }> {
  const [compulsa] = await db
    .insert(compulsas)
    .values({
      obraId,
      rubro: 'seco',
      estado: 'lanzada',
      snapshotHash: 'hash-de-prueba',
      itemsJson: itemsRfq,
      condicionesJson: CONDICIONES,
      mandatoJson: { objetivoMejoraPct: 5, palancas: ['volumen'], maxRondas: 2 },
      version: 1,
      aprobadoPor: titular.usuarioId,
    })
    .returning();

  const [contacto] = await db
    .insert(contactosCompulsa)
    .values({ compulsaId: compulsa.id, proveedorId: corralon.id, canal: 'manual', estado: 'contactado' })
    .returning();

  return { compulsa, contacto };
}

function auditoriaDe(accion: string) {
  return db.select().from(auditoria).where(eq(auditoria.accion, accion));
}

// ---------------------------------------------------------------------------
// 1. Refs de recortes
// ---------------------------------------------------------------------------

describe('refs de recortes (ampliación de parsearRefArchivo)', () => {
  const UUID = '11111111-1111-1111-1111-111111111111';
  const OTRO = '22222222-2222-2222-2222-222222222222';

  it('una ref de documento sigue devolviendo exactamente lo de antes', () => {
    expect(parsearRefArchivo(`estudios/${UUID}/obras/${OTRO}/documentos/${UUID}/original.pdf`)).toEqual({
      estudioId: UUID,
      obraId: OTRO,
      documentoId: UUID,
    });
  });

  it('una ref de recorte se lee con su compulsa', () => {
    expect(
      parsearRefArchivo(`estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/recortes/01-seco-placas.pdf`),
    ).toEqual({ estudioId: UUID, obraId: OTRO, compulsaId: UUID });
  });

  it('el índice de tres dígitos también entra (más de 99 recortes)', () => {
    expect(
      parsearRefArchivo(`estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/recortes/100-aberturas-v2.pdf`),
    ).not.toBeNull();
  });

  it('rechaza toda ref de recorte que no tenga la forma canónica', () => {
    for (const ref of [
      `estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/recortes/../../../../secreto.pdf`,
      `estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/recortes/01-seco-placas.pdf/../otro.pdf`,
      `estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/recortes/01-seco-placas.env`,
      `estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/recortes/seco-placas.pdf`,
      `estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/recortes/01-.pdf`,
      `estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/recortes/01-Seco_Placas.pdf`,
      `estudios/${UUID}/obras/${OTRO}/compulsas/no-es-uuid/recortes/01-seco-placas.pdf`,
      `estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/recortes/`,
      `estudios/${UUID}/obras/${OTRO}/compulsas/${UUID}/01-seco-placas.pdf`,
    ]) {
      expect(parsearRefArchivo(ref), ref).toBeNull();
    }
  });
});

describe('GET /api/archivos sobre un recorte', () => {
  const BYTES = new TextEncoder().encode('%PDF-1.7 recorte de prueba');

  async function pedir(ref: string): Promise<Response> {
    return GET_ARCHIVO(new Request(`http://localhost/api/archivos/${ref}`), {
      params: Promise.resolve({ ref: ref.split('/') }),
    });
  }

  it('sirve el recorte de una compulsa de mi obra', async () => {
    const { compulsa } = await compulsaConContacto();
    const ref = `estudios/${estudioId}/obras/${obraId}/compulsas/${compulsa.id}/recortes/01-seco-placas.pdf`;
    await crearStorageLocal().guardar(ref, BYTES, 'application/pdf');

    cookieActual = token;
    const respuesta = await pedir(ref);

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('Content-Type')).toBe('application/pdf');
    expect(new Uint8Array(await respuesta.arrayBuffer())).toEqual(BYTES);
  });

  it('sin sesión no se sirve', async () => {
    const { compulsa } = await compulsaConContacto();
    const ref = `estudios/${estudioId}/obras/${obraId}/compulsas/${compulsa.id}/recortes/01-seco-placas.pdf`;
    await crearStorageLocal().guardar(ref, BYTES, 'application/pdf');

    cookieActual = undefined;
    expect((await pedir(ref)).status).toBe(401);
  });

  it('una compulsa que no es de esa obra no existe, aunque el archivo esté', async () => {
    const { compulsa } = await compulsaConContacto();
    // La ref nombra MI obra y MI estudio, pero una compulsa de otra obra: sin
    // confirmar contra la base, adivinar un uuid alcanzaría.
    const [ajena] = await db
      .insert(compulsas)
      .values({
        obraId: obraAjenaId,
        rubro: 'seco',
        estado: 'lanzada',
        snapshotHash: 'x',
        itemsJson: [],
        condicionesJson: CONDICIONES,
        version: 1,
      })
      .returning();

    const ref = `estudios/${estudioId}/obras/${obraId}/compulsas/${ajena.id}/recortes/01-seco-placas.pdf`;
    await crearStorageLocal().guardar(ref, BYTES, 'application/pdf');

    cookieActual = token;
    expect((await pedir(ref)).status).toBe(404);
    // Y la compulsa buena sí se sirve: el 404 es por pertenencia, no por ruta.
    const buena = `estudios/${estudioId}/obras/${obraId}/compulsas/${compulsa.id}/recortes/01-seco-placas.pdf`;
    await crearStorageLocal().guardar(buena, BYTES, 'application/pdf');
    expect((await pedir(buena)).status).toBe(200);
  });

  it('la obra de otro estudio no existe (RNF-4)', async () => {
    const [ajena] = await db
      .insert(compulsas)
      .values({
        obraId: obraAjenaId,
        rubro: 'seco',
        estado: 'lanzada',
        snapshotHash: 'x',
        itemsJson: [],
        condicionesJson: CONDICIONES,
        version: 1,
      })
      .returning();

    const ref = `estudios/${otroEstudioId}/obras/${obraAjenaId}/compulsas/${ajena.id}/recortes/01-seco-placas.pdf`;
    await crearStorageLocal().guardar(ref, BYTES, 'application/pdf');

    cookieActual = token;
    expect((await pedir(ref)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 2. Wizard: proveedores y aviso RF-701
// ---------------------------------------------------------------------------

describe('selección de proveedores del wizard (RF-802, §13)', () => {
  it('rankea la shortlist del rubro y deja los no contactables afuera, con motivo', async () => {
    const seleccion = await armarSeleccionProveedoresCore(db, estudioId, 'seco', 'Vicente López');

    expect(seleccion.rankeados.map((r) => r.proveedor.nombre)).toEqual([
      'Corralón San Martín',
      'Ferretería del Centro',
    ]);
    expect(seleccion.rankeados.map((r) => r.grupo)).toEqual(['red', 'zona']);
    expect(seleccion.excluidos).toEqual([
      { proveedorId: noContactar.id, nombre: 'Corralón que no quiere', motivo: 'Pidió no ser contactado.' },
    ]);
    // El de otro rubro ni aparece: no es un excluido, es otra agenda.
    expect(seleccion.rankeados.some((r) => r.proveedor.id === deOtroRubro.id)).toBe(false);
    expect(seleccion.excluidos.some((e) => e.proveedorId === deOtroRubro.id)).toBe(false);
  });

  it('el historial de cotizaciones sube al proveedor al primer grupo', async () => {
    const { contacto } = await compulsaConContacto();
    await db.insert(cotizaciones).values({
      contactoId: contacto.id,
      incluyeIva: false,
      lineasJson: [],
      estado: 'conciliada',
    });

    const seleccion = await armarSeleccionProveedoresCore(db, estudioId, 'seco', 'Vicente López');
    expect(seleccion.rankeados[0].grupo).toBe('red_con_historial');
    expect(seleccion.rankeados[0].cotizaciones).toBe(1);
  });

  it('la agenda de otro estudio no se ve', async () => {
    const seleccion = await armarSeleccionProveedoresCore(db, otroEstudioId, 'seco', 'Vicente López');
    expect(seleccion.rankeados).toEqual([]);
    expect(seleccion.excluidos).toEqual([]);
  });
});

describe('aviso RF-701 en la pantalla de armado', () => {
  it('sin compulsa previa no hay aviso, y baja los ítems del cómputo aprobado', async () => {
    await aprobarSecoConDosItems();

    const preview = await previewRubroCore(db, estudioId, obraId, 'seco');
    expect(preview.aviso).toBeNull();
    expect(preview.items.map((i) => i.claveItem)).toEqual(['seco.masilla', 'seco.placas']);
    expect(preview.items[1].cantidad).toBe(31.68);
    expect(preview.condiciones.validezMinimaDias).toBe(7);
    expect(preview.mandato?.maxRondas).toBe(2);
  });

  it('con la compulsa vigente y el mismo cómputo, avisa que ya hay una en curso', async () => {
    await aprobarSecoConDosItems();
    await compulsaConContacto();

    const preview = await previewRubroCore(db, estudioId, obraId, 'seco');
    expect(preview.aviso?.tipo).toBe('vigente');
    expect(preview.aviso?.version).toBe(1);
  });

  it('si el cómputo cambió, avisa que esto crea la versión 2 y cierra la anterior', async () => {
    await aprobarSecoConDosItems();
    await compulsaConContacto([{ ...ITEM_PLACAS, cantidad: 20 }, ITEM_MASILLA]);

    const preview = await previewRubroCore(db, estudioId, obraId, 'seco');
    expect(preview.aviso?.tipo).toBe('cambio');
    expect(preview.aviso?.version).toBe(1);
    expect(preview.aviso?.versionNueva).toBe(2);
  });

  it('una compulsa cerrada no es una compulsa vigente', async () => {
    await aprobarSecoConDosItems();
    const { compulsa } = await compulsaConContacto();
    await db.update(compulsas).set({ estado: 'cerrada' }).where(eq(compulsas.id, compulsa.id));

    const preview = await previewRubroCore(db, estudioId, obraId, 'seco');
    expect(preview.aviso).toBeNull();
  });

  it('un rubro sin aprobar no ofrece nada que congelar', async () => {
    const preview = await previewRubroCore(db, estudioId, obraId, 'seco');
    expect(preview.aprobado).toBe(false);
    expect(preview.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Preview del presupuesto
// ---------------------------------------------------------------------------

describe('preview del presupuesto (parsear sin persistir)', () => {
  // Dos montos por línea (unitario y total), que es como imprime una planilla:
  // con uno solo la heurística de P5 lo guarda como total y deja el unitario en
  // `null` a propósito (no adivina cuál de los dos es).
  const TEXTO = [
    'Presupuesto Corralón San Martín',
    '31,68 m2 Placa de roca de yeso 12,5 mm para tabique de durlock $ 8.000 $ 253.440',
    '30 kg Masilla lista para juntas $ 3.500 $ 105.000',
    'TOTAL $ 358.440',
    'Validez: 10 días',
  ].join('\n');

  it('lee las líneas, los metadatos y el score que va a quedar, sin escribir nada', async () => {
    const { contacto } = await compulsaConContacto();

    const preview = await previsualizarPresupuestoCore(db, colaborador, contacto.id, {
      nombre: 'presupuesto.txt',
      texto: TEXTO,
    });

    expect(preview.lineas).toHaveLength(2);
    expect(preview.lineas[0].precioUnitario).toBe(8000);
    expect(preview.metadatos.total).toBe(358440);
    expect(preview.metadatos.validezDias).toBe(10);
    expect(preview.score).toBe(1);
    expect(preview.matches).toEqual({ exacto: 2 });
    expect(preview.sustituciones).toEqual([]);
    expect(preview.lineasDescartadas).toBe(0);
    expect(preview.metadatosCorregidos).toEqual([]);

    // Nada se persistió: el preview es una lectura.
    expect(await db.select().from(cotizaciones)).toHaveLength(0);
  });

  it('muestra lo que el saneo va a descartar antes de guardarlo (P5, borde de escritura)', async () => {
    const { contacto } = await compulsaConContacto();

    const lineas: LineaPresupuesto[] = [
      {
        descripcion: 'Placa de roca de yeso 12,5 mm para tabique de durlock',
        unidad: 'm2',
        cantidad: 31.68,
        precioUnitario: 8000,
        precioTotal: 253440,
        claveItemSugerida: null,
        notas: null,
      },
      {
        descripcion: '   ',
        unidad: null,
        cantidad: null,
        precioUnitario: null,
        precioTotal: null,
        claveItemSugerida: null,
        notas: null,
      },
    ];

    const preview = await previsualizarPresupuestoCore(db, colaborador, contacto.id, {
      nombre: 'a-mano.txt',
      lineas,
      metadatos: { total: -1, validezDias: 0 },
    });

    expect(preview.lineas).toHaveLength(1);
    expect(preview.lineasDescartadas).toBe(1);
    expect(preview.metadatosCorregidos).toEqual(['total', 'validezDias']);
    expect(preview.metadatos.total).toBeNull();
    expect(preview.score).toBe(0.5);
    expect(preview.noCotizados).toEqual(['seco.masilla']);
  });

  it('una sustitución de especificación se ve en el preview, antes de confirmar', async () => {
    const { contacto } = await compulsaConContacto();

    const preview = await previsualizarPresupuestoCore(db, colaborador, contacto.id, {
      nombre: 'sustituto.txt',
      lineas: [
        {
          descripcion: 'Placa de roca de yeso 12,5 mm para tabique de ladrillo',
          unidad: 'm2',
          cantidad: 31.68,
          precioUnitario: 8000,
          precioTotal: 253440,
          claveItemSugerida: null,
          notas: null,
        },
      ],
    });

    expect(preview.sustituciones).toEqual(['seco.placas']);
    expect(preview.alertas).toHaveLength(1);
  });

  it('un contacto de otro estudio no existe (RNF-4)', async () => {
    const { contacto } = await compulsaConContacto();
    await expect(
      previsualizarPresupuestoCore(db, ajeno, contacto.id, { nombre: 'x.txt', texto: TEXTO }),
    ).rejects.toThrow(/No encontré ese contacto/);
  });

  it('con rol de lectura no se previsualiza nada (RF-1201)', async () => {
    const { contacto } = await compulsaConContacto();
    await expect(
      previsualizarPresupuestoCore(db, mirona, contacto.id, { nombre: 'x.txt', texto: TEXTO }),
    ).rejects.toThrow(/solo lectura/);
  });
});

// ---------------------------------------------------------------------------
// 4. Cargar el total a mano
// ---------------------------------------------------------------------------

describe('cargar el total de una cotización que no lo declaró (P5 §8)', () => {
  async function cotizacionSinTotal(): Promise<string> {
    const { contacto } = await compulsaConContacto();
    const [cotizacion] = await db
      .insert(cotizaciones)
      .values({ contactoId: contacto.id, incluyeIva: false, lineasJson: [], estado: 'conciliada' })
      .returning();
    return cotizacion.id;
  }

  it('lo guarda y lo deja auditado', async () => {
    const id = await cotizacionSinTotal();
    const cotizacion = await cargarTotalCotizacionCore(db, colaborador, id, 358440);

    expect(cotizacion.total).toBe(358440);
    const [rastro] = await auditoriaDe('cotizacion_total_cargado');
    expect(rastro.diffJson).toMatchObject({ total: { antes: null, despues: 358440 } });
  });

  it('un total imposible no entra (misma política que el saneo)', async () => {
    const id = await cotizacionSinTotal();
    await expect(cargarTotalCotizacionCore(db, colaborador, id, 0)).rejects.toThrow(RangeError);
    await expect(cargarTotalCotizacionCore(db, colaborador, id, -5)).rejects.toThrow(RangeError);
    await expect(cargarTotalCotizacionCore(db, colaborador, id, Number.NaN)).rejects.toThrow(RangeError);
    expect(await auditoriaDe('cotizacion_total_cargado')).toHaveLength(0);
  });

  it('con rol de lectura no se toca (RF-1201) y una cotización ajena no existe (RNF-4)', async () => {
    const id = await cotizacionSinTotal();
    await expect(cargarTotalCotizacionCore(db, mirona, id, 100)).rejects.toThrow(/solo lectura/);
    await expect(cargarTotalCotizacionCore(db, ajeno, id, 100)).rejects.toThrow(/No encontré esa cotización/);
  });
});

// ---------------------------------------------------------------------------
// 5. Estado del contacto a mano (pantalla de conversaciones)
// ---------------------------------------------------------------------------

describe('marcar el estado del contacto a mano', () => {
  it('cerrar un contacto lo cierra y queda auditado', async () => {
    const { contacto } = await compulsaConContacto();
    const actualizado = await cambiarEstadoContactoCore(db, colaborador, contacto.id, 'cerrado');

    expect(actualizado.estado).toBe('cerrado');
    const [rastro] = await auditoriaDe('contacto_estado_cambiado');
    expect(rastro.diffJson).toMatchObject({ estado: { antes: 'contactado', despues: 'cerrado' } });
  });

  it('«cotizó» sin cotización registrada no se puede marcar: la pantalla no miente', async () => {
    const { contacto } = await compulsaConContacto();
    await expect(cambiarEstadoContactoCore(db, colaborador, contacto.id, 'cotizo')).rejects.toThrow(
      /no tiene ninguna cotización registrada/i,
    );
    expect(await auditoriaDe('contacto_estado_cambiado')).toHaveLength(0);
  });

  it('con la cotización registrada, «cotizó» sí se puede volver a marcar', async () => {
    const { contacto } = await compulsaConContacto();
    await db.insert(cotizaciones).values({
      contactoId: contacto.id,
      incluyeIva: false,
      lineasJson: [],
      estado: 'conciliada',
    });
    await db.update(contactosCompulsa).set({ estado: 'cerrado' }).where(eq(contactosCompulsa.id, contacto.id));

    const actualizado = await cambiarEstadoContactoCore(db, colaborador, contacto.id, 'cotizo');
    expect(actualizado.estado).toBe('cotizo');
  });

  it('con rol de lectura no se cambia nada (RF-1201)', async () => {
    const { contacto } = await compulsaConContacto();
    await expect(cambiarEstadoContactoCore(db, mirona, contacto.id, 'cerrado')).rejects.toThrow(
      /solo lectura/,
    );
  });

  it('un contacto de otro estudio no existe (RNF-4)', async () => {
    const { contacto } = await compulsaConContacto();
    await expect(cambiarEstadoContactoCore(db, ajeno, contacto.id, 'cerrado')).rejects.toThrow(
      /No encontré ese contacto/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Sin respuesta hace 7+ días
// ---------------------------------------------------------------------------

describe('«sin respuesta hace 7+ días» (consulta, no cron)', () => {
  const HACE_OCHO_DIAS = new Date('2026-08-18T15:00:00Z');
  const HACE_DOS_DIAS = new Date('2026-08-24T15:00:00Z');

  async function contactoConSaliente(at: Date): Promise<ContactoCompulsa> {
    const { contacto } = await compulsaConContacto();
    await db.insert(mensajes).values({
      contactoId: contacto.id,
      direccion: 'saliente',
      canal: 'manual',
      cuerpo: 'Hola, ¿nos pasás precio?',
      registradoPor: titular.usuarioId,
      at,
    });
    return contacto;
  }

  it('cuenta los días desde el último envío y avisa a partir de 7', async () => {
    const contacto = await contactoConSaliente(HACE_OCHO_DIAS);
    const avisos = await detectarSinRespuestaCore(db, estudioId, obraId, AHORA);

    expect(avisos).toHaveLength(1);
    expect(avisos[0].contactoId).toBe(contacto.id);
    expect(avisos[0].dias).toBe(8);
    expect(avisos[0].proveedor).toBe('Corralón San Martín');
  });

  it('a los dos días no avisa nada', async () => {
    await contactoConSaliente(HACE_DOS_DIAS);
    expect(await detectarSinRespuestaCore(db, estudioId, obraId, AHORA)).toEqual([]);
  });

  it('un borrador sin mandar no cuenta: el reloj arranca cuando se manda', async () => {
    const { contacto } = await compulsaConContacto();
    await db.insert(mensajes).values({
      contactoId: contacto.id,
      direccion: 'saliente',
      canal: 'manual',
      cuerpo: 'Borrador',
      registradoPor: null,
      at: HACE_OCHO_DIAS,
    });
    expect(await detectarSinRespuestaCore(db, estudioId, obraId, AHORA)).toEqual([]);
  });

  it('si el proveedor contestó, no hay silencio que avisar', async () => {
    const contacto = await contactoConSaliente(HACE_OCHO_DIAS);
    await db.insert(mensajes).values({
      contactoId: contacto.id,
      direccion: 'entrante',
      canal: 'manual',
      cuerpo: 'Te lo paso mañana',
      registradoPor: titular.usuarioId,
      at: new Date('2026-08-19T10:00:00Z'),
    });
    expect(await detectarSinRespuestaCore(db, estudioId, obraId, AHORA)).toEqual([]);
  });

  it('un contacto ya cerrado no espera respuesta', async () => {
    const contacto = await contactoConSaliente(HACE_OCHO_DIAS);
    await db.update(contactosCompulsa).set({ estado: 'cerrado' }).where(eq(contactosCompulsa.id, contacto.id));
    expect(await detectarSinRespuestaCore(db, estudioId, obraId, AHORA)).toEqual([]);
  });

  it('notifica al titular una sola vez, aunque la pantalla se abra diez veces', async () => {
    const contacto = await contactoConSaliente(HACE_OCHO_DIAS);
    const avisos = await detectarSinRespuestaCore(db, estudioId, obraId, AHORA);

    const primera = await notificarSinRespuestaCore(db, colaborador, obraId, avisos);
    const segunda = await notificarSinRespuestaCore(db, colaborador, obraId, avisos);
    await notificarSinRespuestaCore(db, colaborador, obraId, avisos);

    expect(primera).toBe(1);
    expect(segunda).toBe(0);

    const escritas = await db.select().from(notificaciones);
    expect(escritas).toHaveLength(1);
    expect(escritas[0].usuarioId).toBe(titular.usuarioId);
    expect(escritas[0].link).toContain(contacto.id);
    expect(escritas[0].titulo).toContain('sin respuesta');
  });

  /**
   * El aviso lo dispara **abrir la pantalla**, que es un GET. Con rol de lectura
   * eso no puede escribir nada: «lectura no muta nada» (RF-1201) vale también
   * para los efectos secundarios de mirar, y el chequeo va en el núcleo, no en
   * la página que lo llama.
   */
  it('con rol de lectura, abrir la pantalla no escribe ninguna notificación', async () => {
    await contactoConSaliente(HACE_OCHO_DIAS);
    const avisos = await detectarSinRespuestaCore(db, estudioId, obraId, AHORA);
    expect(avisos).toHaveLength(1);

    for (let vez = 0; vez < 3; vez += 1) {
      expect(await notificarSinRespuestaCore(db, mirona, obraId, avisos)).toBe(0);
    }
    expect(await db.select().from(notificaciones)).toEqual([]);

    // Y el que sí puede la escribe igual después: el silencio del de lectura no
    // "consume" el aviso.
    expect(await notificarSinRespuestaCore(db, colaborador, obraId, avisos)).toBe(1);
    expect(await db.select().from(notificaciones)).toHaveLength(1);
  });

  it('dos renders concurrentes dejan una sola notificación, no dos', async () => {
    await contactoConSaliente(HACE_OCHO_DIAS);
    const avisos = await detectarSinRespuestaCore(db, estudioId, obraId, AHORA);

    // Sin `await` en el medio: las dos llamadas salen de verdad en paralelo y
    // las dos ven la base sin la notificación (el check-then-insert clásico).
    const [una, otra] = await Promise.all([
      notificarSinRespuestaCore(db, colaborador, obraId, avisos),
      notificarSinRespuestaCore(db, titular, obraId, avisos),
    ]);

    const escritas = await db.select().from(notificaciones);
    expect(escritas).toHaveLength(1);
    // La cuenta que devuelven es la neta: entre las dos reportan una sola.
    expect(una + otra).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Notificación de cotización conciliada (productor que P7 dejó pendiente)
// ---------------------------------------------------------------------------

describe('notificación de cotización conciliada', () => {
  it('le avisa al equipo, menos al que la registró', async () => {
    const { compulsa, contacto } = await compulsaConContacto();
    const [cotizacion] = await db
      .insert(cotizaciones)
      .values({ contactoId: contacto.id, incluyeIva: false, lineasJson: [], estado: 'conciliada' })
      .returning();

    const escritas = await notificarCotizacionConciliadaCore(db, colaborador, {
      tipo: 'cotizacion_conciliada',
      obraId,
      compulsaId: compulsa.id,
      contactoId: contacto.id,
      cotizacionId: cotizacion.id,
      score: 0.8,
      sustituciones: 1,
    });

    expect(escritas).toBe(2); // la titular y la de lectura; el colaborador que la cargó, no
    const filas = await db.select().from(notificaciones);
    expect(filas.map((f) => f.usuarioId).sort()).toEqual(
      [titular.usuarioId, mirona.usuarioId].sort(),
    );
    expect(filas[0].link).toBe(`/obras/${obraId}/compulsas/${compulsa.id}`);
    expect(filas[0].cuerpo).toContain('80%');
    expect(filas[0].cuerpo).toContain('sustitución');
  });

  it('el hook enchufado al flujo real deja la notificación al conciliar', async () => {
    const { compulsa, contacto } = await compulsaConContacto([ITEM_MASILLA]);

    await registrarCotizacion(
      db,
      colaborador,
      contacto.id,
      {
        nombre: 'presupuesto.txt',
        lineas: [
          {
            descripcion: 'Masilla lista para juntas',
            unidad: 'kg',
            cantidad: 30,
            precioUnitario: 3500,
            precioTotal: 105000,
            claveItemSugerida: null,
            notas: null,
          },
        ],
        metadatos: { total: 105000 },
      },
      {
        ahora: () => AHORA,
        notificar: async (evento) => {
          if (evento.tipo !== 'cotizacion_conciliada') return;
          await notificarCotizacionConciliadaCore(db, colaborador, evento);
        },
      },
    );

    const filas = await db.select().from(notificaciones);
    expect(filas).toHaveLength(2);
    expect(filas[0].link).toBe(`/obras/${obraId}/compulsas/${compulsa.id}`);
  });
});

// ---------------------------------------------------------------------------
// Contexto: que la obra de la compulsa sea la que dice la URL
// ---------------------------------------------------------------------------

describe('aislamiento de las pantallas', () => {
  it('los avisos de una obra no traen contactos de otra obra', async () => {
    await compulsaConContacto();
    const [ajena] = await db
      .insert(compulsas)
      .values({
        obraId: obraAjenaId,
        rubro: 'seco',
        estado: 'lanzada',
        snapshotHash: 'x',
        itemsJson: [],
        condicionesJson: CONDICIONES,
        version: 1,
      })
      .returning();
    const [contactoAjeno] = await db
      .insert(contactosCompulsa)
      .values({ compulsaId: ajena.id, proveedorId: corralon.id, canal: 'manual', estado: 'contactado' })
      .returning();
    await db.insert(mensajes).values({
      contactoId: contactoAjeno.id,
      direccion: 'saliente',
      canal: 'manual',
      cuerpo: 'Hola',
      registradoPor: titular.usuarioId,
      at: new Date('2026-08-01T10:00:00Z'),
    });

    // El silencio de ocho meses es de la obra ajena: en esta obra no hay nada
    // que avisar, y el aviso se pide por obra, no por proveedor.
    expect(await detectarSinRespuestaCore(db, estudioId, obraId, AHORA)).toEqual([]);
  });
});
