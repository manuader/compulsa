/**
 * El flujo de compulsa completo, por el canal manual, sobre PGlite en memoria y
 * los PDFs reales de `tests/fixtures/pdfs/`.
 *
 * Se testean los **núcleos** de `@/lib/compulsa/flujo` (no los `*Action`, que
 * son de P8): lo que hay que proteger es qué queda escrito en la base, para qué
 * estudio y con qué rastro.
 *
 * Las cinco cosas que estos tests cuidan:
 *
 *  1. **RF-701:** el hash del snapshot es el del cómputo aprobado, y editar la
 *     planilla después no corrige la compulsa vieja: crea una versión nueva y
 *     cierra la anterior.
 *  2. **RF-902/903:** el presupuesto de 10 ítems (8 exactos, 1 sustitución, 1 no
 *     cotizado) se clasifica entero, da `score = 0,80`, genera **una**
 *     repregunta y **una** alerta roja.
 *  3. **RF-1103:** cada línea conciliada con precio unitario alimenta el índice
 *     del estudio por (clave, zona, mes).
 *  4. **RF-1002:** una sustitución de especificación frena la negociación
 *     automática y escala al usuario.
 *  5. **Aislamiento (RNF-4) y roles (RF-1201):** la compulsa es de la obra, la
 *     obra es del estudio, y lanzarla es del titular.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDbForTests, type Db } from '@/db/client';
import {
  auditoria,
  compulsas,
  computoItems,
  computoRubros,
  conciliacionItems,
  contactosCompulsa,
  cotizaciones,
  documentos,
  entidades,
  estudios,
  laminas,
  mensajes,
  negociaciones,
  obras,
  priceIndex,
  proveedores,
  usuarios,
  type Proveedor,
} from '@/db/schema';
import { ObraNoEncontradaError } from '@/lib/auth/guards';
import { hashSnapshot } from '@/lib/compulsa/snapshot';
import {
  CompulsaVigenteError,
  RolInsuficienteError,
  RubroNoAprobadoError,
  lanzarCompulsa,
  proponerNegociacion,
  registrarCotizacion,
  registrarEnvio,
  registrarMensajeEntrante,
  type ActorCompulsa,
} from '@/lib/compulsa/flujo';
import { FRASES_PALANCA } from '@/lib/negociacion/motor';
import { CanalNoConfiguradoError, getCanal, partirCuerpo } from '@/lib/outreach/canal';
import { banderasDeContacto, leerHilo } from '@/lib/outreach/threads';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import type { StorageAdapter } from '@/lib/storage/index';
import { crearStorageLocal } from '@/lib/storage/local';
import type { LineaPresupuesto, Mandato } from '@/types/domain';

import { createTestDb } from '../helpers/test-db';

const PDFS = new URL('../fixtures/pdfs/', import.meta.url);

/** Fecha fija: el mes del índice de precios es dato pinneado, no el reloj. */
const AHORA = new Date('2026-08-26T15:00:00Z');
const MES = '2026-08';

const MANDATO: Mandato = {
  objetivoMejoraPct: 5,
  palancas: ['volumen', 'adjudicacion_inmediata'],
  maxRondas: 2,
};

let db: Db;
let raizStorage: string;
let storage: StorageAdapter;
let estudioId: string;
let otroEstudioId: string;
let obraId: string;
let titular: ActorCompulsa;
let colaborador: ActorCompulsa;
let ajeno: ActorCompulsa;
let corralon: Proveedor;
let ferreteria: Proveedor;
let noContactar: Proveedor;

const deps = { ahora: () => AHORA };

beforeEach(async () => {
  db = await createTestDb();
  setDbForTests(db);
  raizStorage = await mkdtemp(path.join(tmpdir(), 'compulsa-flujo-'));
  storage = crearStorageLocal(raizStorage);

  const [norte, sur] = await db
    .insert(estudios)
    .values([{ nombre: 'Estudio Norte' }, { nombre: 'Estudio Sur' }])
    .returning();
  estudioId = norte.id;
  otroEstudioId = sur.id;

  const [jefa, pasante, ajena] = await db
    .insert(usuarios)
    .values([
      { estudioId: norte.id, email: 'ana@norte.ar', nombre: 'Ana', passwordHash: 'x', rol: 'titular' },
      { estudioId: norte.id, email: 'beto@norte.ar', nombre: 'Beto', passwordHash: 'x', rol: 'colaborador' },
      { estudioId: sur.id, email: 'sur@sur.ar', nombre: 'Sur', passwordHash: 'x', rol: 'titular' },
    ])
    .returning();

  titular = { usuarioId: jefa.id, email: jefa.email, rol: 'titular', estudioId: norte.id };
  colaborador = { usuarioId: pasante.id, email: pasante.email, rol: 'colaborador', estudioId: norte.id };
  ajeno = { usuarioId: ajena.id, email: ajena.email, rol: 'titular', estudioId: sur.id };

  const [obra] = await db
    .insert(obras)
    .values({ estudioId: norte.id, nombre: 'Casa Demo', zona: 'Vicente López', tipo: 'nueva' })
    .returning();
  obraId = obra.id;

  [corralon, ferreteria, noContactar] = await db
    .insert(proveedores)
    .values([
      { estudioId: norte.id, nombre: 'Corralón San Martín', rubros: ['seco'], zona: 'Vicente López', origen: 'manual' },
      { estudioId: norte.id, nombre: 'Ferretería del Centro', rubros: ['seco'], zona: 'CABA', origen: 'manual' },
      { estudioId: norte.id, nombre: 'Corralón que no quiere', rubros: ['seco'], zona: 'CABA', origen: 'manual', optOut: true },
    ])
    .returning();
});

afterEach(async () => {
  await rm(raizStorage, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Setup pesado: la obra demo procesada + el rubro seco aprobado con 10 ítems
// ---------------------------------------------------------------------------

/**
 * Corre el pipeline real sobre `obra-demo.pdf` (3 láminas, provider mock) y deja
 * el rubro seco aprobado con **10 ítems**: los 6 que emite la plantilla más 4
 * cargados directo en la base, todos colgados del tabique T1 (así heredan su
 * `tipo: durlock` como especificación no sustituible y sus fuentes para los
 * recortes).
 */
async function prepararRubroSeco(): Promise<void> {
  const bytes = await readFile(new URL('obra-demo.pdf', PDFS));
  const archivo = new File([new Uint8Array(bytes)], 'obra-demo.pdf', { type: 'application/pdf' });
  const documento = await subirDocumento(db, storage, obraId, titular.usuarioId, archivo);
  await procesarDocumento(documento.id, { db, storage });

  const [tabique] = await db
    .select()
    .from(entidades)
    .where(and(eq(entidades.obraId, obraId), eq(entidades.nombre, 'T1')));

  const extra = (claveItem: string, descripcion: string, unidad: 'ml' | 'm2', cantidad: number) => ({
    obraId,
    rubro: 'seco' as const,
    entidadId: tabique.id,
    claveItem,
    descripcion,
    unidad,
    cantNeta: cantidad,
    desperdicioPct: 0,
    cantCompra: cantidad,
    presentacion: 'a medida',
    origen: 'explicito' as const,
    fuentesJson: tabique.fuentesJson,
    confianza: 0.9,
  });

  await db.insert(computoItems).values([
    extra('seco.perfil_omega', 'Perfil omega para cielorraso', 'ml', 26),
    extra('seco.banda_acustica', 'Banda acústica autoadhesiva de 70 mm', 'ml', 20),
    extra('seco.lana_vidrio', 'Lana de vidrio de 50 mm para tabique', 'm2', 26),
    extra('seco.bunas', 'Buña perimetral de aluminio', 'ml', 12),
  ]);

  await db.insert(computoRubros).values({
    obraId,
    rubro: 'seco',
    estado: 'aprobado',
    aprobadoPor: titular.usuarioId,
    aprobadoAt: AHORA,
  });
}

/** Las 3 líneas de la segunda cotización: todas exactas, ninguna sustitución. */
const LINEAS_FERRETERIA: LineaPresupuesto[] = [
  {
    descripcion: 'Placa de roca de yeso 1,20 x 2,40 m',
    unidad: 'm2',
    cantidad: 31.68,
    precioUnitario: 8000,
    precioTotal: 253440,
    claveItemSugerida: null,
    notas: null,
  },
  {
    descripcion: 'Montante para tabique de durlock cada 0,40 m',
    unidad: 'u',
    cantidad: 14,
    precioUnitario: 4000,
    precioTotal: 56000,
    claveItemSugerida: null,
    notas: null,
  },
  {
    descripcion: 'Masilla para juntas',
    unidad: 'kg',
    cantidad: 30,
    precioUnitario: 3500,
    precioTotal: 105000,
    claveItemSugerida: null,
    notas: null,
  },
];

function mensajesDe(contactoId: string) {
  return db
    .select()
    .from(mensajes)
    .where(eq(mensajes.contactoId, contactoId))
    .orderBy(asc(mensajes.at), asc(mensajes.id));
}

function auditoriaDe(accion: string) {
  return db.select().from(auditoria).where(eq(auditoria.accion, accion));
}

// ---------------------------------------------------------------------------

describe('canales', () => {
  it('el manual es el único configurado; los otros dicen qué variable les falta', async () => {
    const manual = getCanal('manual');
    expect(manual.canal).toBe('manual');
    await expect(
      manual.enviar({ contactoId: 'x', canal: 'manual', cuerpo: 'Hola', adjuntos: [] }),
    ).resolves.toEqual({ ok: true });

    expect(() => getCanal('whatsapp')).toThrow(CanalNoConfiguradoError);
    expect(() => getCanal('whatsapp')).toThrow(/WHATSAPP_TOKEN/);
    expect(() => getCanal('voz')).toThrow(/RETELL_API_KEY/);
    expect(() => getCanal('email')).toThrow(/SMTP_URL/);
  });
});

describe('lanzar la compulsa', () => {
  it('un colaborador no puede lanzarla (RF-1201)', async () => {
    await expect(
      lanzarCompulsa(db, storage, colaborador, obraId, 'seco', { proveedorIds: [corralon.id] }, deps),
    ).rejects.toThrow(RolInsuficienteError);
  });

  it('una obra de otro estudio no existe (RNF-4)', async () => {
    await expect(
      lanzarCompulsa(db, storage, ajeno, obraId, 'seco', { proveedorIds: [corralon.id] }, deps),
    ).rejects.toThrow(ObraNoEncontradaError);
  });

  it('un rubro sin aprobar no se compulsa (RF-404)', async () => {
    await expect(
      lanzarCompulsa(db, storage, titular, obraId, 'seco', { proveedorIds: [corralon.id] }, deps),
    ).rejects.toThrow(RubroNoAprobadoError);
  });
});

describe('flujo manual completo sobre el rubro seco', () => {
  it('lanza, cotiza, concilia, negocia y recompulsa', async () => {
    await prepararRubroSeco();

    // --- 1. Lanzamiento -----------------------------------------------------
    const lanzamiento = await lanzarCompulsa(
      db,
      storage,
      titular,
      obraId,
      'seco',
      { proveedorIds: [corralon.id, ferreteria.id, noContactar.id], mandato: MANDATO },
      deps,
    );

    expect(lanzamiento.compulsa.version).toBe(1);
    expect(lanzamiento.compulsa.estado).toBe('lanzada');
    expect(lanzamiento.compulsa.itemsJson).toHaveLength(10);
    expect(lanzamiento.recompulsa).toBe(false);

    // RF-701: el hash guardado es el del snapshot que se mandó.
    expect(lanzamiento.compulsa.snapshotHash).toBe(
      hashSnapshot(lanzamiento.compulsa.itemsJson, lanzamiento.compulsa.condicionesJson),
    );

    // La spec no sustituible sale del tabique de origen, no de un default.
    const placas = lanzamiento.compulsa.itemsJson.find((i) => i.claveItem === 'seco.placas');
    expect(placas?.specsCriticas).toEqual({ tipo: 'durlock' });
    expect(placas?.cantidad).toBe(31.68);

    // §13: el opt-out nunca entra, y no desaparece en silencio.
    expect(lanzamiento.contactos).toHaveLength(2);
    expect(lanzamiento.excluidos).toEqual([
      {
        proveedorId: noContactar.id,
        nombre: 'Corralón que no quiere',
        motivo: 'Pidió no ser contactado.',
      },
    ]);

    const [contactoCorralon, contactoFerreteria] = lanzamiento.contactos;
    expect(contactoCorralon.estado).toBe('pendiente');
    expect(contactoCorralon.canal).toBe('manual');

    // --- 2. Texto y recortes ------------------------------------------------
    expect(lanzamiento.texto).toContain('Estudio Norte');
    expect(lanzamiento.texto).toContain('IVA discriminado');
    expect(lanzamiento.texto).toContain('Vicente López');

    expect(lanzamiento.recortes).toHaveLength(10);
    for (const recorte of lanzamiento.recortes) {
      expect(recorte.ref).toContain(`/compulsas/${lanzamiento.compulsa.id}/recortes/`);
      const bytes = await storage.leer(recorte.ref);
      expect(bytes.length).toBeGreaterThan(0);
    }

    const [saliente] = await mensajesDe(contactoCorralon.id);
    expect(saliente.direccion).toBe('saliente');
    expect(saliente.registradoPor).toBeNull(); // pendiente_envio_manual
    const partido = partirCuerpo(saliente.cuerpo);
    expect(partido.texto).toBe(lanzamiento.texto);
    expect(partido.adjuntos).toHaveLength(10);

    expect(await auditoriaDe('compulsa_lanzada')).toHaveLength(1);

    // Relanzar sin tocar el cómputo no crea una versión: es la misma compulsa.
    await expect(
      lanzarCompulsa(db, storage, titular, obraId, 'seco', { proveedorIds: [corralon.id] }, deps),
    ).rejects.toThrow(CompulsaVigenteError);

    // --- 3. Envío y respuesta ----------------------------------------------
    const envio = await registrarEnvio(db, colaborador, contactoCorralon.id, deps);
    expect(envio.contacto.estado).toBe('contactado');

    const hiloTrasEnvio = await leerHilo(db, estudioId, contactoCorralon.id);
    expect(hiloTrasEnvio.mensajes[0].estado).toBe('enviado');
    expect(hiloTrasEnvio.pendientes).toBe(0);

    const entrante = await registrarMensajeEntrante(
      db,
      colaborador,
      contactoCorralon.id,
      'Te paso el presupuesto por mail.',
      deps,
    );
    expect(entrante.contacto.estado).toBe('contactado'); // la cotización la registra el paso siguiente

    // --- 4. Cotización + conciliación (pin RF-902) --------------------------
    const primera = await registrarCotizacion(
      db,
      colaborador,
      contactoCorralon.id,
      { nombre: 'Presupuesto Seco RF902.pdf', texto: 'PRESUPUESTO 1234\n(lo lee el fixture)' },
      deps,
    );

    expect(primera.conciliacion.score).toBe(0.8);
    expect(primera.cotizacion.scoreFidelidad).toBe(0.8);
    expect(primera.cotizacion.estado).toBe('conciliada');
    expect(primera.cotizacion.total).toBe(953480);
    expect(primera.cotizacion.validezDias).toBe(10);
    expect(primera.cotizacion.plazoDias).toBe(15);
    expect(primera.cotizacion.incluyeIva).toBe(false);
    expect(primera.requiereDecision).toBe(true);

    const conciliados = await db
      .select()
      .from(conciliacionItems)
      .where(eq(conciliacionItems.cotizacionId, primera.cotizacion.id));
    expect(conciliados).toHaveLength(10);
    const porMatch = conciliados.reduce<Record<string, number>>((acc, fila) => {
      acc[fila.match] = (acc[fila.match] ?? 0) + 1;
      return acc;
    }, {});
    expect(porMatch).toEqual({ exacto: 8, sustituto: 1, no_cotizado: 1 });

    // Una repregunta (la del ítem no cotizado), como borrador saliente.
    expect(primera.conciliacion.repreguntas).toHaveLength(1);
    expect(primera.conciliacion.alertas).toHaveLength(1);
    const hiloCorralon = await leerHilo(db, estudioId, contactoCorralon.id);
    const borradores = hiloCorralon.mensajes.filter((m) => m.estado === 'pendiente_envio_manual');
    expect(borradores).toHaveLength(1);
    expect(borradores[0].texto).toContain('Buña perimetral de aluminio');

    // La sustitución queda como bandera consultable, no como un flag suelto.
    const banderas = await banderasDeContacto(db, estudioId, contactoCorralon.id);
    expect(banderas).toHaveLength(1);
    expect(banderas[0].claveItem).toBe('seco.soleras');

    const [contactoCotizo] = await db
      .select()
      .from(contactosCompulsa)
      .where(eq(contactosCompulsa.id, contactoCorralon.id));
    expect(contactoCotizo.estado).toBe('cotizo');

    // --- 5. Índice de precios (RF-1103) -------------------------------------
    const indice = await db
      .select()
      .from(priceIndex)
      .where(and(eq(priceIndex.estudioId, estudioId), eq(priceIndex.mes, MES)))
      .orderBy(asc(priceIndex.claveItem));
    // Las 8 exactas con precio unitario; la sustituida y la no cotizada, no.
    expect(indice).toHaveLength(8);
    expect(indice.map((f) => f.claveItem)).not.toContain('seco.soleras');

    const placasIndice = indice.find((f) => f.claveItem === 'seco.placas');
    expect(placasIndice?.zona).toBe('Vicente López');
    expect(placasIndice?.n).toBe(1);
    expect([placasIndice?.p25, placasIndice?.p50, placasIndice?.p75]).toEqual([8500, 8500, 8500]);
    expect(placasIndice?.muestrasJson).toEqual([8500]);

    // --- 6. Segunda cotización, ya con las líneas parseadas ------------------
    await registrarEnvio(db, colaborador, contactoFerreteria.id, deps);
    const segunda = await registrarCotizacion(
      db,
      colaborador,
      contactoFerreteria.id,
      {
        nombre: 'presupuesto-ferreteria.pdf',
        lineas: LINEAS_FERRETERIA,
        metadatos: { total: 414440, incluyeIva: false, validezDias: 15, plazoDias: 20 },
      },
      deps,
    );

    expect(segunda.conciliacion.score).toBe(0.3);
    expect(segunda.requiereDecision).toBe(false);
    expect(segunda.cotizacion.total).toBe(414440);

    // Los 7 ítems que no cotizó quedan como borradores, uno por ítem. El orden
    // entre ellos no se promete (comparten el `at`): lo que importa es que estén
    // los siete y que cada uno nombre su ítem.
    const hiloFerreteria = await leerHilo(db, estudioId, contactoFerreteria.id);
    const borradoresFerreteria = hiloFerreteria.mensajes.filter(
      (m) => m.estado === 'pendiente_envio_manual',
    );
    expect(borradoresFerreteria).toHaveLength(7);
    const preguntados = borradoresFerreteria.map((m) => m.texto).join('\n');
    expect(preguntados).toContain('Banda acústica autoadhesiva de 70 mm');
    expect(preguntados).toContain('Tornillos para placa de roca de yeso');
    expect(preguntados).toContain('Solera para tabique de durlock');
    // Lo que sí cotizó no se repregunta.
    expect(preguntados).not.toContain('Masilla para juntas');

    const placasConDosMuestras = await db
      .select()
      .from(priceIndex)
      .where(and(eq(priceIndex.estudioId, estudioId), eq(priceIndex.claveItem, 'seco.placas')));
    expect(placasConDosMuestras[0].n).toBe(2);
    expect(placasConDosMuestras[0].muestrasJson).toEqual([8000, 8500]);
    expect([placasConDosMuestras[0].p25, placasConDosMuestras[0].p50, placasConDosMuestras[0].p75]).toEqual(
      [8000, 8000, 8500],
    );

    // --- 7. Negociación (RF-1001 / RF-1002) ---------------------------------
    const escalada = await proponerNegociacion(db, colaborador, primera.cotizacion.id, deps);
    expect(escalada).toEqual({ procede: false, motivo: 'escala_spec', requiereDecision: true });
    // No se le manda nada al proveedor con una spec cambiada arriba de la mesa.
    const hiloTrasEscalar = await leerHilo(db, estudioId, contactoCorralon.id);
    expect(hiloTrasEscalar.mensajes.filter((m) => m.estado === 'pendiente_envio_manual')).toHaveLength(1);

    const propuesta = await proponerNegociacion(db, colaborador, segunda.cotizacion.id, deps);
    if (!propuesta.procede) throw new Error(`No debería escalar: ${propuesta.motivo}`);
    expect(propuesta.ronda).toBe(1);
    expect(propuesta.objetivoTotal).toBe(393718);
    expect(propuesta.texto).toContain('$');
    expect(propuesta.texto).toContain(FRASES_PALANCA.volumen);
    expect(propuesta.texto).toContain(FRASES_PALANCA.adjudicacion_inmediata);
    // El texto nunca ofrece una palanca que el mandato no habilita.
    expect(propuesta.texto).not.toContain(FRASES_PALANCA.plazo_pago);

    const rondas = await db
      .select()
      .from(negociaciones)
      .where(eq(negociaciones.cotizacionId, segunda.cotizacion.id));
    expect(rondas).toHaveLength(1);
    expect(rondas[0].ronda).toBe(1);
    expect(rondas[0].resultado).toBe('pendiente');

    const [contactoNegociando] = await db
      .select()
      .from(contactosCompulsa)
      .where(eq(contactosCompulsa.id, contactoFerreteria.id));
    expect(contactoNegociando.estado).toBe('negociando');

    // --- 8. RF-701: editar el cómputo obliga a una versión nueva ------------
    await db
      .update(computoItems)
      .set({ cantCompra: 40 })
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, 'seco.placas')));

    const recompulsa = await lanzarCompulsa(
      db,
      storage,
      titular,
      obraId,
      'seco',
      { proveedorIds: [corralon.id], mandato: MANDATO },
      deps,
    );

    expect(recompulsa.compulsa.version).toBe(2);
    expect(recompulsa.recompulsa).toBe(true);
    expect(recompulsa.compulsa.snapshotHash).not.toBe(lanzamiento.compulsa.snapshotHash);
    expect(await auditoriaDe('compulsa_recompulsada')).toHaveLength(1);

    const [anterior] = await db
      .select()
      .from(compulsas)
      .where(eq(compulsas.id, lanzamiento.compulsa.id));
    expect(anterior.estado).toBe('cerrada');
    expect(anterior.version).toBe(1);
  });
});

describe('el presupuesto pegado a mano, sin fixture', () => {
  it('lo lee la heurística y sale conciliado igual', async () => {
    await prepararRubroSeco();
    const [puente] = await db
      .insert(proveedores)
      .values({
        estudioId,
        nombre: 'Corralón El Puente',
        rubros: ['seco'],
        zona: 'Vicente López',
        origen: 'manual',
      })
      .returning();

    const { contactos } = await lanzarCompulsa(
      db,
      storage,
      titular,
      obraId,
      'seco',
      { proveedorIds: [puente.id] },
      deps,
    );

    const pegado = [
      'CORRALÓN EL PUENTE — Presupuesto 88',
      '31,68 m2 Placa de roca de yeso 1,20 x 2,40 m $ 9.000 $ 285.120',
      '90 ml Cinta de papel para juntas $ 600 $ 54.000',
      'TOTAL $ 339.120',
      'Validez de la oferta: 7 días',
    ].join('\n');

    const registrada = await registrarCotizacion(
      db,
      colaborador,
      contactos[0].id,
      { nombre: 'pegado-del-whatsapp.txt', texto: pegado },
      deps,
    );

    expect(registrada.cotizacion.lineasJson).toHaveLength(2);
    expect(registrada.cotizacion.lineasJson[0].precioUnitario).toBe(9000);
    expect(registrada.cotizacion.total).toBe(339120);
    expect(registrada.cotizacion.validezDias).toBe(7);
    // 2 exactos sobre 10 ítems pedidos.
    expect(registrada.conciliacion.score).toBe(0.2);
    expect(registrada.muestrasIndice).toBe(2);
    // El texto crudo queda guardado para poder releerlo sin pedírselo de nuevo.
    expect(registrada.cotizacion.rawTexto).toBe(pegado);
  });
});

describe('ítems agregados (sin entidad única)', () => {
  /** Una obra mínima con dos tabiques y un ítem agregado del rubro seco. */
  async function obraConDosTabiques(tipoDelSegundo: string): Promise<void> {
    const [documento] = await db
      .insert(documentos)
      .values({
        obraId,
        nombreArchivo: 'planta.pdf',
        tipo: 'plano',
        archivoRef: 'x',
        mime: 'application/pdf',
        hash: 'h',
        subidoPor: titular.usuarioId,
      })
      .returning();
    const [lamina] = await db
      .insert(laminas)
      .values({ documentoId: documento.id, obraId, numeroPagina: 1, archivoRef: 'x' })
      .returning();

    await db.insert(entidades).values([
      {
        obraId,
        laminaId: lamina.id,
        tipo: 'tabique',
        nombre: 'T1',
        atributosJson: { tipo: 'durlock', largoM: 5, alturaM: 2.6 },
        fuentesJson: [{ laminaId: lamina.id, bbox: [0.1, 0.1, 0.2, 0.2] }],
        confianza: 0.9,
      },
      {
        obraId,
        laminaId: lamina.id,
        tipo: 'tabique',
        nombre: 'T2',
        atributosJson: { tipo: tipoDelSegundo, largoM: 3, alturaM: 2.6 },
        fuentesJson: [{ laminaId: lamina.id, bbox: [0.4, 0.1, 0.2, 0.2] }],
        confianza: 0.9,
      },
    ]);

    await db.insert(computoItems).values({
      obraId,
      rubro: 'seco',
      // Sin `entidadId`: es la suma de los dos tabiques, como emite la plantilla.
      claveItem: 'seco.placas',
      descripcion: 'Placa de roca de yeso (1,20 × 2,40 m)',
      unidad: 'm2',
      cantNeta: 41.6,
      desperdicioPct: 12,
      cantCompra: 46.08,
      presentacion: '16 placas de 2,88 m²',
      origen: 'explicito',
      fuentesJson: [{ laminaId: lamina.id, bbox: [0.1, 0.1, 0.2, 0.2] }],
      confianza: 0.9,
    });

    await db.insert(computoRubros).values({
      obraId,
      rubro: 'seco',
      estado: 'aprobado',
      aprobadoPor: titular.usuarioId,
      aprobadoAt: AHORA,
    });
  }

  it('hereda la spec del rubro cuando todas las entidades coinciden', async () => {
    await obraConDosTabiques('durlock');

    const { compulsa } = await lanzarCompulsa(
      db,
      storage,
      titular,
      obraId,
      'seco',
      { proveedorIds: [corralon.id] },
      deps,
    );

    expect(compulsa.itemsJson[0].specsCriticas).toEqual({ tipo: 'durlock' });
  });

  it('no inventa la spec cuando las entidades no coinciden', async () => {
    await obraConDosTabiques('mamposteria');

    const { compulsa } = await lanzarCompulsa(
      db,
      storage,
      titular,
      obraId,
      'seco',
      { proveedorIds: [corralon.id] },
      deps,
    );

    expect(compulsa.itemsJson[0].specsCriticas).toEqual({});
  });
});

describe('aislamiento entre estudios', () => {
  it('un proveedor ajeno no cierra la compulsa que ya estaba en curso', async () => {
    await prepararRubroSeco();
    const primera = await lanzarCompulsa(
      db,
      storage,
      titular,
      obraId,
      'seco',
      { proveedorIds: [corralon.id] },
      deps,
    );

    // El cómputo cambia, así que este segundo lanzamiento sería una recompulsa
    // legítima… si el proveedor existiera.
    await db
      .update(computoItems)
      .set({ cantCompra: 41 })
      .where(and(eq(computoItems.obraId, obraId), eq(computoItems.claveItem, 'seco.placas')));

    const [ajenoProveedor] = await db
      .insert(proveedores)
      .values({
        estudioId: otroEstudioId,
        nombre: 'Corralón del Sur',
        rubros: ['seco'],
        zona: 'La Plata',
        origen: 'manual',
      })
      .returning();

    await expect(
      lanzarCompulsa(db, storage, titular, obraId, 'seco', { proveedorIds: [ajenoProveedor.id] }, deps),
    ).rejects.toThrow(/No encontré ese proveedor/);

    // La compulsa vigente sigue vigente: nada se cerró por un id que no era.
    const [sigueEnCurso] = await db
      .select()
      .from(compulsas)
      .where(eq(compulsas.id, primera.compulsa.id));
    expect(sigueEnCurso.estado).toBe('lanzada');
    expect(await db.select().from(compulsas)).toHaveLength(1);
  });

  it('un contacto de otro estudio no existe para registrar una cotización', async () => {
    await prepararRubroSeco();
    const { contactos } = await lanzarCompulsa(
      db,
      storage,
      titular,
      obraId,
      'seco',
      { proveedorIds: [corralon.id] },
      deps,
    );

    await expect(
      registrarCotizacion(db, ajeno, contactos[0].id, { nombre: 'x.pdf', lineas: [] }, deps),
    ).rejects.toThrow(/No encontré ese contacto/);

    // Y no quedó nada escrito: ni cotización ni mensaje nuevo.
    expect(await db.select().from(cotizaciones)).toHaveLength(0);
  });
});
