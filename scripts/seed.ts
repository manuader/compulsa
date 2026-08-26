/**
 * Datos de demo: `npm run seed`.
 *
 * Deja el workspace con una obra de verdad —documentos subidos, láminas
 * analizadas, cómputo, un ítem tocado a mano y la bandeja con una consulta
 * respondida y otra abierta— para poder recorrer las pantallas sin cargar nada.
 *
 * Cuatro reglas de este archivo:
 *
 *  1. **Idempotente.** Correrlo dos veces seguidas no agrega una fila en ninguna
 *     tabla, ni siquiera en `auditoria`: cada paso pregunta si ya está hecho
 *     antes de hacerlo. Reprocesar un documento ya procesado no duplicaría
 *     entidades ni ítems (el pipeline se encarga), pero sí dejaría auditorías
 *     nuevas — por eso lo que ya está subido no se vuelve a procesar.
 *  2. **Base persistente.** Usa `getDb()` sin tocar `NODE_ENV`: en desarrollo eso
 *     es la PGlite de `data/pglite/`, que es la misma que levanta `npm run dev`.
 *     Si `DATABASE_URL` está seteada, siembra ahí.
 *  3. **Pipeline real, provider mock.** Los PDFs se suben y se procesan con el
 *     pipeline de verdad, pero el análisis se inyecta como mock a propósito: el
 *     seed tiene que ser determinístico y correr offline, y los fixtures de
 *     `obra-demo.pdf` son justamente lo que el mock sabe leer.
 *  4. **Todo lo que escribe el seed queda auditado**, con el mismo actor y el
 *     mismo diff que si lo hubiera hecho el arquitecto desde la pantalla: los
 *     núcleos de la planilla (`recalcularCompra`, `diffDeItem`) y de la bandeja
 *     (`responderHallazgo`) se reusan, no se reimplementan.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { and, asc, eq } from 'drizzle-orm';

import { diffDeItem, recalcularCompra } from '@/app/obras/[obraId]/computo/actions';
import { getDb, type Db } from '@/db/client';
import {
  auditoria,
  computoItems,
  documentos,
  entidades,
  estudios,
  hallazgos,
  laminas,
  obras,
  usuarios,
  type Obra,
  type Usuario,
} from '@/db/schema';
import { crearProviderMock } from '@/lib/analysis/mock';
import { registrarAuditoria } from '@/lib/audit';
import { hashearPassword } from '@/lib/auth/password';
import { responderHallazgo } from '@/lib/bandeja/resolver';
import { claveEscala } from '@/lib/pipeline/claves';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import { getStorage } from '@/lib/storage/index';

// ---------------------------------------------------------------------------
// Qué siembra el seed
// ---------------------------------------------------------------------------

const ESTUDIO = 'Estudio Demo';
const USUARIO = {
  email: 'demo@compulsa.ar',
  password: 'demo1234',
  nombre: 'Demo Compulsa',
} as const;
const OBRA = {
  nombre: 'Casa Belgrano — reforma demo',
  zona: 'Belgrano, CABA',
  tipo: 'reforma',
} as const;

const DIR_PDFS = path.join(process.cwd(), 'tests', 'fixtures', 'pdfs');

/**
 * Los documentos de la obra demo, en orden de subida.
 *
 * `sin-escala.pdf` se sube **dos veces** a propósito: es el mismo archivo subido
 * como dos versiones (el pipeline versiona por nombre), y así la obra queda con
 * dos láminas bloqueadas por escala (RF-201). Una la destraba el arquitecto en
 * el paso siguiente —esa es la consulta respondida— y la otra queda abierta,
 * para que la bandeja tenga contenido y el gate de aprobación se vea trabajando.
 * Es la única forma honesta de tener las dos cosas: con estos fixtures, el
 * bloqueo por escala es el único hallazgo que la obra genera (`obra-demo.pdf`
 * trae todos los datos completos y no deja ningún hueco).
 */
const DOC_OBRA = 'obra-demo.pdf';
const DOC_SIN_ESCALA = 'sin-escala.pdf';

const DOCUMENTOS: readonly { nombre: string; copias: number }[] = [
  { nombre: DOC_OBRA, copias: 1 },
  { nombre: DOC_SIN_ESCALA, copias: 2 },
];

/** El ítem que el arquitecto corrige a mano en la planilla. */
const EDICION = {
  claveItem: 'seco.placas',
  /** El tabique llega hasta la losa (3,00 m) y no hasta el cielorraso: 5 × 3,00 × 2 caras. */
  cantNeta: 30,
} as const;

/** Lo que el arquitecto contesta en la consulta de escala que sí resuelve. */
const RESPUESTA_ESCALA = {
  valor: '1:20',
  nota: 'El detalle está dibujado a 1:20; lo verifiqué contra el espesor del tabique.',
} as const;

// ---------------------------------------------------------------------------
// Pasos, todos con su guarda de idempotencia
// ---------------------------------------------------------------------------

async function asegurarEstudio(db: Db): Promise<{ id: string; creado: boolean }> {
  const [previo] = await db.select().from(estudios).where(eq(estudios.nombre, ESTUDIO));
  if (previo) return { id: previo.id, creado: false };

  const [creado] = await db.insert(estudios).values({ nombre: ESTUDIO }).returning();
  await registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: USUARIO.email,
    accion: 'estudio_creado',
    targetRef: `estudios:${creado.id}`,
    diff: { nombre: ESTUDIO, origen: 'seed' },
  });
  return { id: creado.id, creado: true };
}

async function asegurarUsuario(db: Db, estudioId: string): Promise<{ usuario: Usuario; creado: boolean }> {
  const [previo] = await db.select().from(usuarios).where(eq(usuarios.email, USUARIO.email));
  if (previo) return { usuario: previo, creado: false };

  const [creado] = await db
    .insert(usuarios)
    .values({
      estudioId,
      email: USUARIO.email,
      nombre: USUARIO.nombre,
      passwordHash: await hashearPassword(USUARIO.password),
      rol: 'titular',
    })
    .returning();
  await registrarAuditoria({
    actorTipo: 'usuario',
    actorNombre: USUARIO.email,
    accion: 'usuario_creado',
    targetRef: `usuarios:${creado.id}`,
    diff: { email: USUARIO.email, rol: 'titular', origen: 'seed' },
  });
  return { usuario: creado, creado: true };
}

async function asegurarObra(db: Db, estudioId: string): Promise<{ obra: Obra; creada: boolean }> {
  const [previa] = await db
    .select()
    .from(obras)
    .where(and(eq(obras.estudioId, estudioId), eq(obras.nombre, OBRA.nombre)));
  if (previa) return { obra: previa, creada: false };

  const [creada] = await db
    .insert(obras)
    .values({ estudioId, nombre: OBRA.nombre, zona: OBRA.zona, tipo: OBRA.tipo })
    .returning();
  await registrarAuditoria({
    obraId: creada.id,
    actorTipo: 'usuario',
    actorNombre: USUARIO.email,
    accion: 'obra_creada',
    targetRef: `obras:${creada.id}`,
    diff: { nombre: OBRA.nombre, zona: OBRA.zona, tipo: OBRA.tipo, origen: 'seed' },
  });
  return { obra: creada, creada: true };
}

/**
 * Sube y procesa lo que falte de `DOCUMENTOS`. Lo ya subido no se vuelve a
 * procesar: el reproceso es idempotente en datos pero no en `auditoria`, y la
 * promesa del seed es que la segunda corrida no agrega ni una fila.
 */
async function asegurarDocumentos(db: Db, obra: Obra, usuario: Usuario): Promise<number> {
  const storage = getStorage();
  // Explícito: el seed corre offline y determinístico aunque haya key exportada.
  const provider = crearProviderMock();

  const existentes = await db.select().from(documentos).where(eq(documentos.obraId, obra.id));
  const porNombre = new Map<string, number>();
  for (const fila of existentes) {
    porNombre.set(fila.nombreArchivo, (porNombre.get(fila.nombreArchivo) ?? 0) + 1);
  }

  let subidos = 0;
  for (const { nombre, copias } of DOCUMENTOS) {
    const yaEstan = porNombre.get(nombre) ?? 0;
    if (yaEstan >= copias) continue;

    const bytes = await readFile(path.join(DIR_PDFS, nombre));
    for (let n = yaEstan; n < copias; n += 1) {
      const archivo = new File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
      const documento = await subirDocumento(db, storage, obra.id, usuario.id, archivo);
      await procesarDocumento(documento.id, { db, storage, provider });
      subidos += 1;
    }
  }

  return subidos;
}

/**
 * Responde la consulta de escala de la **primera** versión de `sin-escala.pdf`:
 * el arquitecto carga la escala y la lámina se destraba y se re-analiza (RF-201).
 * La consulta de la segunda versión queda abierta.
 */
async function asegurarConsultaRespondida(db: Db, obra: Obra, usuario: Usuario): Promise<boolean> {
  const [primera] = await db
    .select()
    .from(documentos)
    .where(and(eq(documentos.obraId, obra.id), eq(documentos.nombreArchivo, DOC_SIN_ESCALA)))
    .orderBy(asc(documentos.version))
    .limit(1);
  if (!primera) return false;

  const [lamina] = await db.select().from(laminas).where(eq(laminas.documentoId, primera.id));
  if (!lamina) return false;

  const [hallazgo] = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obra.id), eq(hallazgos.clave, claveEscala(lamina.id))));
  if (!hallazgo || hallazgo.estado !== 'abierto') return false;

  const resultado = await responderHallazgo(
    { obraId: obra.id, hallazgoId: hallazgo.id, ...RESPUESTA_ESCALA },
    { usuarioId: usuario.id, email: usuario.email },
    { storage: getStorage(), provider: crearProviderMock() },
  );
  if (!resultado.ok) throw new Error(`No pude responder la consulta de escala: ${resultado.error}`);
  return true;
}

/**
 * Edita un ítem de la planilla como lo haría el arquitecto: recalcula la compra
 * con la presentación del ítem, marca `editado_por` (desde acá el recompute no
 * lo toca) y audita el diff. Mismos núcleos que `editarItemAction`.
 */
async function asegurarItemEditado(db: Db, obra: Obra, usuario: Usuario): Promise<boolean> {
  const [item] = await db
    .select()
    .from(computoItems)
    .where(and(eq(computoItems.obraId, obra.id), eq(computoItems.claveItem, EDICION.claveItem)));
  if (!item || item.editadoPor !== null) return false;

  const compra = await recalcularCompra({
    unidad: item.unidad,
    cantNeta: EDICION.cantNeta,
    desperdicioPct: item.desperdicioPct,
    presentacion: item.presentacion,
    cantCompraActual: item.cantCompra,
  });

  const antes = {
    descripcion: item.descripcion,
    cantNeta: item.cantNeta,
    desperdicioPct: item.desperdicioPct,
    cantCompra: item.cantCompra,
    presentacion: item.presentacion,
  };
  const despues = { ...antes, cantNeta: EDICION.cantNeta, ...compra };

  const diff = await diffDeItem(antes, despues);
  if (Object.keys(diff).length === 0) return false;

  await db
    .update(computoItems)
    .set({ ...despues, editadoPor: usuario.id, updatedAt: new Date() })
    .where(eq(computoItems.id, item.id));

  await registrarAuditoria({
    obraId: obra.id,
    actorTipo: 'usuario',
    actorNombre: usuario.email,
    accion: 'computo_item_editado',
    targetRef: `computo_items:${item.claveItem}`,
    diff,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Resumen (y prueba de idempotencia: dos corridas tienen que imprimir lo mismo)
// ---------------------------------------------------------------------------

async function contar(db: Db, obraId: string): Promise<Record<string, number>> {
  const [docs, lams, ents, items, halls, audits] = await Promise.all([
    db.select().from(documentos).where(eq(documentos.obraId, obraId)),
    db.select().from(laminas).where(eq(laminas.obraId, obraId)),
    db.select().from(entidades).where(eq(entidades.obraId, obraId)),
    db.select().from(computoItems).where(eq(computoItems.obraId, obraId)),
    db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId)),
    db.select().from(auditoria).where(eq(auditoria.obraId, obraId)),
  ]);

  return {
    documentos: docs.length,
    laminas: lams.length,
    entidades: ents.length,
    'ítems de cómputo': items.length,
    'ítems editados a mano': items.filter((i) => i.editadoPor !== null).length,
    consultas: halls.length,
    'consultas abiertas': halls.filter((h) => h.estado === 'abierto').length,
    'consultas respondidas': halls.filter((h) => h.estado === 'respondido').length,
    auditoría: audits.length,
  };
}

async function main(): Promise<void> {
  const db = await getDb();

  const estudio = await asegurarEstudio(db);
  const { usuario, creado: usuarioCreado } = await asegurarUsuario(db, estudio.id);
  const { obra, creada: obraCreada } = await asegurarObra(db, estudio.id);
  const subidos = await asegurarDocumentos(db, obra, usuario);
  const respondida = await asegurarConsultaRespondida(db, obra, usuario);
  const editado = await asegurarItemEditado(db, obra, usuario);

  const hechos = [
    estudio.creado ? `estudio «${ESTUDIO}»` : null,
    usuarioCreado ? `usuario ${USUARIO.email}` : null,
    obraCreada ? `obra «${OBRA.nombre}»` : null,
    subidos > 0
      ? `${subidos} ${subidos === 1 ? 'documento subido y procesado' : 'documentos subidos y procesados'}`
      : null,
    respondida ? '1 consulta de escala respondida' : null,
    editado ? `1 ítem editado a mano (${EDICION.claveItem})` : null,
  ].filter((linea): linea is string => linea !== null);

  console.log('');
  if (hechos.length === 0) {
    console.log('Seed: no había nada que hacer, los datos de demo ya estaban.');
  } else {
    console.log('Seed: se creó');
    for (const hecho of hechos) console.log(`  · ${hecho}`);
  }

  console.log('');
  console.log(`Obra «${OBRA.nombre}» (${obra.id}):`);
  for (const [etiqueta, cantidad] of Object.entries(await contar(db, obra.id))) {
    console.log(`  ${etiqueta.padEnd(24)}${String(cantidad).padStart(4)}`);
  }

  console.log('');
  console.log(`Entrá con ${USUARIO.email} / ${USUARIO.password} y andá a /obras.`);
}

/**
 * Corta el proceso a propósito.
 *
 * La PGlite persistida de `data/pglite/` deja el event loop vivo y `getDb()` no
 * expone el cliente para cerrarlo, así que un script que espere a quedarse sin
 * trabajo no termina nunca. Antes de salir vaciamos stdout: `process.exit()`
 * puede cortar una escritura a un pipe a mitad de camino, y la salida del seed
 * suele ir a uno.
 */
async function terminar(codigo: number): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.write('', () => resolve());
  });
  process.exit(codigo);
}

try {
  await main();
  await terminar(0);
} catch (error) {
  console.error('');
  console.error(`Seed: no pude sembrar los datos de demo — ${(error as Error).message}`);
  await terminar(1);
}
