/**
 * Datos de demo: `npm run seed`.
 *
 * Deja el workspace con **dos obras** de verdad y una compulsa en curso, para
 * poder recorrer las pantallas sin cargar nada:
 *
 *  · **Casa Belgrano — reforma demo** (`obra-demo.pdf` + dos láminas sin
 *    escala): cómputo completo, un ítem tocado a mano, una consulta de escala
 *    respondida y otra abierta. Es la que muestra el pipeline y la bandeja.
 *  · **Casa Reforma — demo** (`obra-reforma.pdf`): un muro a demoler, un
 *    tabique existente que no computa y una ventana sin acotar en la planta que
 *    la planilla de carpinterías sí acota. De ahí salen tres deducciones: una
 *    validada (la altura del tabique, que es la que destraba el cómputo de
 *    seco) y dos esperando en la bandeja. Sobre su rubro `seco` aprobado corre
 *    la compulsa: cuatro proveedores en la agenda (uno con opt-out), dos
 *    contactados, dos presupuestos conciliados —uno con una sustitución de
 *    especificación y un ítem sin cotizar, que deja una repregunta en
 *    borrador—, el índice de precios del mes poblado y una ronda de negociación
 *    propuesta.
 *  · **Casa Conjunta — demo** (`obra-conjunta.pdf`): el expediente como
 *    conjunto. Seis láminas donde la planta no acota una sola altura y el corte
 *    la declara una vez; la bandeja abre UNA consulta de dato de obra por los
 *    siete elementos que la esperan, el seed la responde como lo haría el
 *    arquitecto y el recompute propaga los 2,60 m a todos. Trae además los
 *    cuatro rubros nuevos poblados (terminaciones, sanitaria, eléctrica) y deja
 *    abierta la otra consulta agrupada —hasta dónde llega el revestimiento del
 *    baño— para que la bandeja tenga algo que mostrar.
 *
 * A nivel estudio siembra también la **lista de precios**: diez renglones que
 * cubren los rubros viejos y los nuevos, para que la planilla salga con la
 * columna de precio llena y con su fuente («lista») a la vista.
 *
 * Cinco reglas de este archivo:
 *
 *  1. **Idempotente.** Correrlo dos veces seguidas no agrega una fila en ninguna
 *     tabla, ni siquiera en `auditoria`: cada paso pregunta si ya está hecho
 *     antes de hacerlo. Reprocesar un documento ya procesado no duplicaría
 *     entidades ni ítems (el pipeline se encarga), pero sí dejaría auditorías
 *     nuevas — por eso lo que ya está subido no se vuelve a procesar.
 *  2. **Base persistente.** Usa `getDb()` sin tocar `NODE_ENV`: en desarrollo eso
 *     es la PGlite de `data/pglite/`, que es la misma que levanta `npm run dev`.
 *     Si `DATABASE_URL` está seteada, siembra ahí.
 *  3. **Pipeline real, providers mock.** Los PDFs se suben y se procesan con el
 *     pipeline de verdad y los presupuestos entran por el flujo de verdad, pero
 *     el análisis y el parser se inyectan como mock **a propósito**: el seed
 *     tiene que ser determinístico y correr offline aunque quien lo corra tenga
 *     `ANTHROPIC_API_KEY` exportada.
 *  4. **Núcleos, no reimplementaciones.** Todo pasa por el mismo código que las
 *     pantallas: `responderHallazgo`, `validarDeduccion`, `aprobarRubroCore`,
 *     `crearProveedor`, `lanzarCompulsa`, `registrarEnvio`,
 *     `registrarCotizacion`, `proponerNegociacion`, `crearInvitacion`,
 *     `crearNotificacion`.
 *  5. **Todo lo que escribe el seed queda auditado**, con el mismo actor y el
 *     mismo diff que si lo hubiera hecho el arquitecto.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { and, asc, count, eq, inArray } from 'drizzle-orm';

import {
  aprobarRubroCore,
  diffDeItem,
  recalcularCompra,
} from '@/app/obras/[obraId]/computo/actions';
import { getDb, type Db } from '@/db/client';
import {
  auditoria,
  compulsas,
  computoItems,
  contactosCompulsa,
  cotizaciones,
  datosObra,
  deducciones,
  documentos,
  entidades,
  estudios,
  hallazgos,
  invitaciones,
  laminas,
  negociaciones,
  notificaciones,
  obras,
  preciosReferencia,
  priceIndex,
  proveedores,
  usuarios,
  type Obra,
  type Proveedor,
  type Usuario,
} from '@/db/schema';
import { crearProviderMock } from '@/lib/analysis/mock';
import { crearProviderPresupuestoMock } from '@/lib/analysis/presupuesto-mock';
import { registrarAuditoria } from '@/lib/audit';
import { hashearPassword } from '@/lib/auth/password';
import { responderHallazgo } from '@/lib/bandeja/resolver';
import {
  lanzarCompulsa,
  proponerNegociacion,
  registrarCotizacion,
  registrarEnvio,
  type ActorCompulsa,
} from '@/lib/compulsa/flujo';
import { validarDeduccion, type ActorDeduccion } from '@/lib/deduccion/persistencia';
import { claveEscala } from '@/lib/pipeline/claves';
import { guardarPrecio, type ActorPrecios } from '@/lib/precios/gestion';
import { procesarDocumento, subirDocumento } from '@/lib/pipeline/procesar';
import { crearNotificacion } from '@/lib/plataforma/notificaciones';
import { crearInvitacion, type ActorPlataforma } from '@/lib/plataforma/usuarios';
import { crearProveedor, marcarOptOut, type ActorProveedor } from '@/lib/proveedores/gestion';
import { getStorage } from '@/lib/storage/index';
import type { Unidad } from '@/types/domain';

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

/** La segunda obra: la que tiene deducciones, compulsa y negociación. */
const OBRA_COMPULSA = {
  nombre: 'Casa Reforma — demo',
  zona: 'Villa Urquiza, CABA',
  tipo: 'reforma',
} as const;

/**
 * La tercera obra: el expediente como conjunto.
 *
 * El nombre **no** matchea ningún fixture de cruce (`slug('Casa Conjunta —
 * demo')` no es `obra-conjunta`), y eso es a propósito: sin el cruce, la altura
 * de local no aparece sola y la bandeja abre la consulta agrupada que el seed
 * después responde. Es la demo del camino que le importa al arquitecto —una
 * pregunta, una respuesta, siete elementos computados—, no la del cruce, que ya
 * tiene el golden 3.
 */
const OBRA_CONJUNTA = {
  nombre: 'Casa Conjunta — demo',
  zona: 'Caballito, CABA',
  tipo: 'nueva',
} as const;

const DIR_PDFS = path.join(process.cwd(), 'tests', 'fixtures', 'pdfs');
const DIR_PRESUPUESTOS = path.join(process.cwd(), 'tests', 'fixtures', 'presupuestos');

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
const DOC_REFORMA = 'obra-reforma.pdf';
const DOC_CONJUNTA = 'obra-conjunta.pdf';

const DOCUMENTOS: readonly { nombre: string; copias: number }[] = [
  { nombre: DOC_OBRA, copias: 1 },
  { nombre: DOC_SIN_ESCALA, copias: 2 },
];

const DOCUMENTOS_COMPULSA: readonly { nombre: string; copias: number }[] = [
  { nombre: DOC_REFORMA, copias: 1 },
];

const DOCUMENTOS_CONJUNTA: readonly { nombre: string; copias: number }[] = [
  { nombre: DOC_CONJUNTA, copias: 1 },
];

/**
 * La consulta agrupada que el seed responde: la altura de local de PB.
 *
 * Es UNA sola para los cuatro tabiques, el muro y los dos ambientes de la
 * planta. Antes de la ola del expediente eran siete preguntas con la misma
 * respuesta; ahora se contesta una vez y el recompute la propaga.
 */
const ALTURA_DE_LOCAL = { clave: 'dato_obra.altura_local.PB', valor: '2,60' } as const;

/**
 * La lista de precios del estudio: diez renglones, cinco de los rubros de
 * siempre y cinco de los que trajo esta ola.
 *
 * La fecha es **fija** y no `fechaHoyIso()`: el seed promete que la segunda
 * corrida no cambia una fila, y una fecha que se mueve con el reloj rompería
 * esa promesa al día siguiente (`guardarPrecio` vería un diff y auditaría).
 *
 * Los precios son de referencia, redondos y a propósito no realistas al peso:
 * lo que la demo tiene que mostrar es la **cascada** —el ítem sale con
 * `fuente: 'lista'` y la fecha del renglón— y no una lista de precios de
 * corralón que quedaría vieja en un mes.
 */
const FECHA_LISTA = '2026-08-01';

const LISTA_PRECIOS: readonly {
  claveItem: string;
  descripcion: string;
  unidad: Unidad;
  precio: number;
}[] = [
  { claveItem: 'seco.placas', descripcion: 'Placa de roca de yeso (1,20 × 2,40 m)', unidad: 'm2', precio: 9800 },
  { claveItem: 'seco.soleras', descripcion: 'Solera de 70 mm', unidad: 'ml', precio: 3900 },
  { claveItem: 'seco.montantes', descripcion: 'Montante de 70 mm', unidad: 'u', precio: 5200 },
  { claveItem: 'pintura.latex_paredes', descripcion: 'Látex interior para paredes', unidad: 'l', precio: 4300 },
  { claveItem: 'gruesa.cemento', descripcion: 'Cemento de albañilería', unidad: 'kg', precio: 260 },
  { claveItem: 'terminaciones.solado.porcelanato', descripcion: 'Porcelanato 60 × 60', unidad: 'm2', precio: 22500 },
  { claveItem: 'terminaciones.zocalo.madera', descripcion: 'Zócalo de madera', unidad: 'ml', precio: 6400 },
  { claveItem: 'terminaciones.contrapiso', descripcion: 'Contrapiso bajo solado', unidad: 'm2', precio: 7800 },
  { claveItem: 'sanitaria.canieria.ac.20', descripcion: 'Caño de termofusión Ø 20 (agua caliente)', unidad: 'ml', precio: 3100 },
  { claveItem: 'electrica.boca.luz', descripcion: 'Boca de luz completa', unidad: 'u', precio: 18500 },
];

/**
 * La deducción que el arquitecto firma en la demo: el ancho de la puerta P3,
 * que la planta no acota y la planilla de carpinterías sí. Al validarla, el
 * ítem `aberturas.P3` pasa a `origen: 'deducido'` y su consulta se cierra sola.
 *
 * Las otras dos —el ancho y el alto de la ventana V5— quedan en `propuesta`,
 * que es lo que hace que `/obras/<id>/deducciones` tenga algo que mostrar y que
 * la bandeja conserve una consulta bloqueante.
 */
const DEDUCCION_A_VALIDAR = { entidad: 'P3', campo: 'anchoM' } as const;

/** Rubro de la compulsa de demo. Es el único que la obra deja aprobar. */
const RUBRO_COMPULSA = 'seco' as const;

/**
 * La agenda de proveedores del estudio. El último tiene `opt_out`: es el caso
 * del §13 que hay que poder ver en pantalla —un proveedor que pidió no ser
 * contactado queda excluido del lanzamiento, con el motivo escrito.
 */
const PROVEEDORES: readonly {
  nombre: string;
  rubros: readonly ('seco' | 'aberturas' | 'pintura' | 'gruesa')[];
  zona: string;
  telefono?: string;
  email?: string;
  contacto?: string;
  optOut?: boolean;
}[] = [
  {
    nombre: 'Corralón San Martín',
    rubros: ['seco', 'gruesa'],
    zona: 'Villa Urquiza, CABA',
    telefono: '11 4555-1020',
    email: 'ventas@corralonsanmartin.com.ar',
    contacto: 'Rubén Salgado',
  },
  {
    nombre: 'Ferretería del Centro',
    rubros: ['seco', 'pintura'],
    zona: 'Villa Urquiza, CABA',
    telefono: '11 4777-3040',
    email: 'pedidos@ferreteriadelcentro.com.ar',
    contacto: 'Silvia Paz',
  },
  {
    nombre: 'Maderera Norte',
    rubros: ['aberturas'],
    zona: 'Vicente López, GBA',
    telefono: '11 4711-8890',
    email: 'info@madereranorte.com.ar',
    contacto: 'Hernán Gómez',
  },
  {
    nombre: 'Aberturas del Oeste',
    rubros: ['aberturas', 'seco'],
    zona: 'Ramos Mejía, GBA',
    telefono: '11 4658-2211',
    email: 'contacto@aberturasdeloeste.com.ar',
    contacto: 'Lucía Ferrari',
    optOut: true,
  },
];

/** Quiénes reciben el pedido de la compulsa de demo, en orden. */
const CONTACTADOS = ['Corralón San Martín', 'Ferretería del Centro'] as const;

/**
 * Los presupuestos que "mandan" los proveedores. Son texto plano en es-AR —lo
 * que llega por mail o por WhatsApp— y los lee la heurística del provider mock,
 * el mismo camino que usa el arquitecto que pega un presupuesto en la pantalla.
 *
 * El de Corralón San Martín tiene **una sustitución** (ofrece solera para
 * tabique de ladrillo donde el pedido dice durlock) y **no cotiza la cinta**:
 * de ahí salen la bandera roja de la comparativa y la repregunta en borrador.
 */
const PRESUPUESTOS: readonly { proveedor: string; archivo: string }[] = [
  { proveedor: 'Corralón San Martín', archivo: 'corralon-san-martin.txt' },
  { proveedor: 'Ferretería del Centro', archivo: 'ferreteria-del-centro.txt' },
];

/** Con quién se negocia: el más caro de los dos, y sin sustituciones. */
const A_NEGOCIAR = 'Ferretería del Centro';

/**
 * Los avisos de muestra de la campanita. Llevan `claveDedup` porque el seed es
 * idempotente: la segunda corrida no tiene que dejar una segunda copia, y el
 * UNIQUE `(usuario_id, clave_dedup)` de `notificaciones` es exactamente eso.
 */
const AVISOS: readonly { titulo: string; cuerpo: string; link: string; claveDedup: string }[] = [
  {
    titulo: 'Bienvenido a Compulsa',
    cuerpo:
      'Este estudio viene con dos obras de ejemplo cargadas. Empezá por el expediente de Casa Belgrano ' +
      'o mirá la compulsa de seco de Casa Reforma.',
    link: '/obras',
    claveDedup: 'seed.bienvenida',
  },
  {
    titulo: 'Tenés 2 deducciones esperando tu visto bueno',
    cuerpo:
      'En Casa Reforma, el motor cruzó la planta con la planilla de carpinterías y propone el ancho y ' +
      'el alto de V5. Ningún dato se escribe sin que lo valides.',
    link: '/obras',
    claveDedup: 'seed.deducciones',
  },
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

type DatosObra = { nombre: string; zona: string; tipo: Obra['tipo'] };

async function asegurarObra(
  db: Db,
  estudioId: string,
  datos: DatosObra,
): Promise<{ obra: Obra; creada: boolean }> {
  const [previa] = await db
    .select()
    .from(obras)
    .where(and(eq(obras.estudioId, estudioId), eq(obras.nombre, datos.nombre)));
  if (previa) return { obra: previa, creada: false };

  const [creada] = await db
    .insert(obras)
    .values({ estudioId, nombre: datos.nombre, zona: datos.zona, tipo: datos.tipo })
    .returning();
  await registrarAuditoria({
    obraId: creada.id,
    actorTipo: 'usuario',
    actorNombre: USUARIO.email,
    accion: 'obra_creada',
    targetRef: `obras:${creada.id}`,
    diff: { ...datos, origen: 'seed' },
  });
  return { obra: creada, creada: true };
}

/**
 * Sube y procesa lo que falte de la lista. Lo ya subido no se vuelve a
 * procesar: el reproceso es idempotente en datos pero no en `auditoria`, y la
 * promesa del seed es que la segunda corrida no agrega ni una fila.
 */
async function asegurarDocumentos(
  db: Db,
  obra: Obra,
  usuario: Usuario,
  lista: readonly { nombre: string; copias: number }[],
): Promise<number> {
  const storage = getStorage();
  // Explícito: el seed corre offline y determinístico aunque haya key exportada.
  const provider = crearProviderMock();

  const existentes = await db.select().from(documentos).where(eq(documentos.obraId, obra.id));
  const porNombre = new Map<string, number>();
  for (const fila of existentes) {
    porNombre.set(fila.nombreArchivo, (porNombre.get(fila.nombreArchivo) ?? 0) + 1);
  }

  let subidos = 0;
  for (const { nombre, copias } of lista) {
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
// Obra 2: deducciones, agenda de proveedores y compulsa en curso
// ---------------------------------------------------------------------------

/**
 * Valida **una sola** deducción: la del ancho de P3, que es la que hace que la
 * puerta se pueda computar. Las dos de V5 quedan `propuesta`, que es lo que
 * hace que `/obras/<id>/deducciones` tenga algo para mostrar.
 *
 * Pasa por `validarDeduccion`, el mismo núcleo que el botón de la bandeja: el
 * dato baja a la entidad con las fuentes de las dos láminas, el recompute deja
 * el ítem con `origen: 'deducido'` y la consulta por el dato faltante se cierra
 * sola.
 */
async function asegurarDeduccionValidada(
  db: Db,
  obra: Obra,
  actor: ActorDeduccion,
): Promise<boolean> {
  const [fila] = await db
    .select({ id: deducciones.id, estado: deducciones.estado })
    .from(deducciones)
    .innerJoin(entidades, eq(entidades.id, deducciones.entidadId))
    .where(
      and(
        eq(deducciones.obraId, obra.id),
        eq(deducciones.campo, DEDUCCION_A_VALIDAR.campo),
        eq(entidades.nombre, DEDUCCION_A_VALIDAR.entidad),
      ),
    );
  if (!fila || fila.estado !== 'propuesta') return false;

  const resultado = await validarDeduccion({ obraId: obra.id, deduccionId: fila.id }, actor);
  if (!resultado.ok) throw new Error(`No pude validar la deducción de P3: ${resultado.error}`);
  return true;
}

/** La agenda del estudio, con el opt-out del §13 ya registrado. */
async function asegurarProveedores(
  db: Db,
  estudioId: string,
  actor: ActorProveedor,
): Promise<{ creados: number; porNombre: Map<string, Proveedor> }> {
  const existentes = await db
    .select()
    .from(proveedores)
    .where(eq(proveedores.estudioId, estudioId));
  const porNombre = new Map(existentes.map((fila) => [fila.nombre, fila]));

  let creados = 0;
  for (const datos of PROVEEDORES) {
    if (porNombre.has(datos.nombre)) continue;

    const { optOut, ...payload } = datos;
    const alta = await crearProveedor(db, estudioId, payload, actor);
    if (!alta.ok) {
      throw new Error(
        `No pude crear el proveedor «${datos.nombre}»: ${Object.values(alta.errores).join('; ')}`,
      );
    }
    const proveedor = optOut
      ? await marcarOptOut(db, estudioId, alta.proveedor.id, actor)
      : alta.proveedor;
    porNombre.set(proveedor.nombre, proveedor);
    creados += 1;
  }

  return { creados, porNombre };
}

/**
 * Aprueba el rubro y lanza la compulsa a los dos proveedores de la lista,
 * registrando además el envío de los dos borradores (que es lo que en la vida
 * real hace el arquitecto cuando manda el mail).
 */
async function asegurarCompulsa(
  db: Db,
  obra: Obra,
  actor: ActorCompulsa,
  agenda: ReadonlyMap<string, Proveedor>,
): Promise<boolean> {
  const [previa] = await db.select().from(compulsas).where(eq(compulsas.obraId, obra.id));
  if (previa) return false;

  const aprobacion = await aprobarRubroCore(
    db,
    { usuarioId: actor.usuarioId, email: actor.email, estudioId: actor.estudioId },
    obra.id,
    RUBRO_COMPULSA,
  );
  if (!aprobacion.ok) throw new Error(`No pude aprobar el rubro seco: ${aprobacion.error}`);

  const proveedorIds = CONTACTADOS.map((nombre) => {
    const proveedor = agenda.get(nombre);
    if (!proveedor) throw new Error(`Falta el proveedor «${nombre}» en la agenda del estudio.`);
    return proveedor.id;
  });

  const lanzamiento = await lanzarCompulsa(
    db,
    getStorage(),
    actor,
    obra.id,
    RUBRO_COMPULSA,
    { proveedorIds },
  );

  for (const contacto of lanzamiento.contactos) {
    await registrarEnvio(db, actor, contacto.id);
  }
  return true;
}

/**
 * Registra los dos presupuestos por el flujo real: el provider mock lee el
 * texto es-AR del fixture con su heurística, la conciliación clasifica línea
 * por línea, deja las repreguntas en borrador y alimenta el índice de precios.
 */
async function asegurarCotizaciones(
  db: Db,
  obra: Obra,
  actor: ActorCompulsa,
): Promise<{ registradas: number; repreguntas: number; muestras: number }> {
  const contactos = await db
    .select({ id: contactosCompulsa.id, proveedor: proveedores.nombre })
    .from(contactosCompulsa)
    .innerJoin(compulsas, eq(compulsas.id, contactosCompulsa.compulsaId))
    .innerJoin(proveedores, eq(proveedores.id, contactosCompulsa.proveedorId))
    .where(eq(compulsas.obraId, obra.id));
  const porProveedor = new Map(contactos.map((fila) => [fila.proveedor, fila.id]));

  const yaCotizaron = new Set(
    (
      await db
        .select({ contactoId: cotizaciones.contactoId })
        .from(cotizaciones)
        .where(
          inArray(
            cotizaciones.contactoId,
            contactos.map((fila) => fila.id),
          ),
        )
    ).map((fila) => fila.contactoId),
  );

  // Explícito, igual que el provider de láminas: el seed no sale a la red.
  const presupuesto = crearProviderPresupuestoMock();
  let registradas = 0;
  let repreguntas = 0;
  let muestras = 0;

  for (const { proveedor, archivo } of PRESUPUESTOS) {
    const contactoId = porProveedor.get(proveedor);
    if (contactoId === undefined || yaCotizaron.has(contactoId)) continue;

    const texto = await readFile(path.join(DIR_PRESUPUESTOS, archivo), 'utf8');
    const resultado = await registrarCotizacion(
      db,
      actor,
      contactoId,
      { nombre: archivo, texto },
      { presupuesto },
    );
    registradas += 1;
    repreguntas += resultado.repreguntasCreadas;
    muestras += resultado.muestrasIndice;
  }

  return { registradas, repreguntas, muestras };
}

/**
 * Propone la ronda 1 al más caro de los dos. El otro tiene una sustitución de
 * especificación y el motor **no** negocia esas: escala al usuario (RF-1002).
 */
async function asegurarNegociacion(db: Db, obra: Obra, actor: ActorCompulsa): Promise<boolean> {
  const [fila] = await db
    .select({ id: cotizaciones.id })
    .from(cotizaciones)
    .innerJoin(contactosCompulsa, eq(contactosCompulsa.id, cotizaciones.contactoId))
    .innerJoin(compulsas, eq(compulsas.id, contactosCompulsa.compulsaId))
    .innerJoin(proveedores, eq(proveedores.id, contactosCompulsa.proveedorId))
    .where(and(eq(compulsas.obraId, obra.id), eq(proveedores.nombre, A_NEGOCIAR)));
  if (!fila) return false;

  const [rondas] = await db
    .select({ total: count() })
    .from(negociaciones)
    .where(eq(negociaciones.cotizacionId, fila.id));
  if ((rondas?.total ?? 0) > 0) return false;

  const resultado = await proponerNegociacion(db, actor, fila.id);
  if (!resultado.procede) {
    throw new Error(`La negociación de demo no salió: el motor la escaló por «${resultado.motivo}».`);
  }
  return true;
}

/** Una invitación de colaborador vigente, para poder probar el alta con código. */
/**
 * La lista de precios del estudio, renglón por renglón, con el mismo núcleo que
 * la pantalla `/estudio/precios` (`guardarPrecio`, origen `manual`).
 *
 * Idempotente por construcción: `guardarPrecio` compara contra la fila que ya
 * está y, si nada cambió, no escribe ni audita. Devuelve cuántos renglones
 * tocó, que en la segunda corrida es cero.
 */
async function asegurarPrecios(db: Db, actor: ActorPrecios): Promise<number> {
  let tocados = 0;
  for (const fila of LISTA_PRECIOS) {
    const resultado = await guardarPrecio(db, actor, { ...fila, fecha: FECHA_LISTA }, 'manual');
    if (!resultado.ok) {
      throw new Error(
        `No pude sembrar el precio de ${fila.claveItem}: ${Object.values(resultado.errores).join(' ')}`,
      );
    }
    if (resultado.creado || Object.keys(resultado.cambios).length > 0) tocados += 1;
  }
  return tocados;
}

/**
 * Responde la consulta agrupada de la altura de local de PB, como lo haría el
 * arquitecto en la bandeja: un número, una vez.
 *
 * Es el gesto que resume la ola. La consulta apunta a un **dato de obra**, no a
 * una entidad: responderla escribe `datos_obra.altura_local.PB` y el recompute
 * la propaga a los cuatro tabiques, al muro y a los dos ambientes que la
 * estaban esperando. Todo eso lo hace `responderHallazgo`, que es el mismo
 * núcleo que la pantalla.
 *
 * Si la consulta ya está respondida (segunda corrida) no hace nada.
 */
async function asegurarAlturaDeLocal(db: Db, obra: Obra, usuario: Usuario): Promise<boolean> {
  const [hallazgo] = await db
    .select()
    .from(hallazgos)
    .where(and(eq(hallazgos.obraId, obra.id), eq(hallazgos.clave, ALTURA_DE_LOCAL.clave)));
  if (!hallazgo || hallazgo.estado !== 'abierto') return false;

  const resultado = await responderHallazgo(
    { obraId: obra.id, hallazgoId: hallazgo.id, valor: ALTURA_DE_LOCAL.valor },
    { usuarioId: usuario.id, email: usuario.email },
  );
  if (!resultado.ok) {
    throw new Error(`No pude responder la altura de local: ${resultado.error}`);
  }
  return true;
}

async function asegurarInvitacion(db: Db, actor: ActorPlataforma): Promise<string | null> {
  const abiertas = await db
    .select()
    .from(invitaciones)
    .where(eq(invitaciones.estudioId, actor.estudioId));
  const vigente = abiertas.find(
    (fila) => fila.usadaPor === null && fila.expiraAt.getTime() > Date.now(),
  );
  if (vigente) return null;

  const invitacion = await crearInvitacion(db, actor, 'colaborador');
  return invitacion.codigo;
}

/** Los avisos de la campanita. El `claveDedup` los hace idempotentes. */
async function asegurarNotificaciones(db: Db, usuario: Usuario): Promise<number> {
  let creadas = 0;
  for (const aviso of AVISOS) {
    creadas += await crearNotificacion(db, [usuario.id], aviso);
  }
  return creadas;
}

// ---------------------------------------------------------------------------
// Resumen (y prueba de idempotencia: dos corridas tienen que imprimir lo mismo)
// ---------------------------------------------------------------------------

async function contar(db: Db, obraId: string): Promise<Record<string, number>> {
  const [docs, lams, ents, items, halls, deducs, audits, datos] = await Promise.all([
    db.select().from(documentos).where(eq(documentos.obraId, obraId)),
    db.select().from(laminas).where(eq(laminas.obraId, obraId)),
    db.select().from(entidades).where(eq(entidades.obraId, obraId)),
    db.select().from(computoItems).where(eq(computoItems.obraId, obraId)),
    db.select().from(hallazgos).where(eq(hallazgos.obraId, obraId)),
    db.select().from(deducciones).where(eq(deducciones.obraId, obraId)),
    db.select().from(auditoria).where(eq(auditoria.obraId, obraId)),
    db.select().from(datosObra).where(eq(datosObra.obraId, obraId)),
  ]);

  return {
    documentos: docs.length,
    laminas: lams.length,
    entidades: ents.length,
    'ítems de cómputo': items.length,
    'ítems editados a mano': items.filter((i) => i.editadoPor !== null).length,
    'ítems deducidos': items.filter((i) => i.origen === 'deducido').length,
    'ítems con precio': items.filter((i) => i.precioJson !== null).length,
    'datos de obra': datos.length,
    consultas: halls.length,
    'consultas abiertas': halls.filter((h) => h.estado === 'abierto').length,
    'consultas respondidas': halls.filter((h) => h.estado === 'respondido').length,
    'deducciones propuestas': deducs.filter((d) => d.estado === 'propuesta').length,
    'deducciones validadas': deducs.filter((d) => d.estado === 'validada').length,
    auditoría: audits.length,
  };
}

/** Lo que sembró la compulsa, que es de estudio y no de obra. */
async function contarCompulsa(db: Db, obraId: string, estudioId: string): Promise<Record<string, number>> {
  const filasCompulsas = await db.select().from(compulsas).where(eq(compulsas.obraId, obraId));
  const ids = filasCompulsas.map((fila) => fila.id);

  const contactos = ids.length
    ? await db.select().from(contactosCompulsa).where(inArray(contactosCompulsa.compulsaId, ids))
    : [];
  const cotizaciones_ = contactos.length
    ? await db
        .select()
        .from(cotizaciones)
        .where(inArray(cotizaciones.contactoId, contactos.map((fila) => fila.id)))
    : [];
  const rondas = cotizaciones_.length
    ? await db
        .select()
        .from(negociaciones)
        .where(inArray(negociaciones.cotizacionId, cotizaciones_.map((fila) => fila.id)))
    : [];

  const [agenda] = await db
    .select({ total: count() })
    .from(proveedores)
    .where(eq(proveedores.estudioId, estudioId));
  const [indice] = await db
    .select({ total: count() })
    .from(priceIndex)
    .where(eq(priceIndex.estudioId, estudioId));
  const [avisos] = await db.select({ total: count() }).from(notificaciones);
  const [invits] = await db
    .select({ total: count() })
    .from(invitaciones)
    .where(eq(invitaciones.estudioId, estudioId));
  const [lista] = await db
    .select({ total: count() })
    .from(preciosReferencia)
    .where(eq(preciosReferencia.estudioId, estudioId));

  return {
    proveedores: agenda?.total ?? 0,
    compulsas: filasCompulsas.length,
    contactos: contactos.length,
    cotizaciones: cotizaciones_.length,
    'cotizaciones conciliadas': cotizaciones_.filter((f) => f.estado === 'conciliada').length,
    negociaciones: rondas.length,
    'índice de precios': indice?.total ?? 0,
    'lista de precios': lista?.total ?? 0,
    invitaciones: invits?.total ?? 0,
    notificaciones: avisos?.total ?? 0,
  };
}

function imprimirTabla(titulo: string, filas: Record<string, number>): void {
  console.log('');
  console.log(titulo);
  for (const [etiqueta, cantidad] of Object.entries(filas)) {
    console.log(`  ${etiqueta.padEnd(26)}${String(cantidad).padStart(4)}`);
  }
}

async function main(): Promise<void> {
  const db = await getDb();

  const estudio = await asegurarEstudio(db);
  const { usuario, creado: usuarioCreado } = await asegurarUsuario(db, estudio.id);

  // Los actores: el mismo usuario titular con la forma que pide cada núcleo.
  const base = { usuarioId: usuario.id, email: usuario.email };
  const actorCompulsa: ActorCompulsa = { ...base, rol: 'titular', estudioId: estudio.id };
  const actorProveedor: ActorProveedor = { ...base, rol: 'titular' };
  const actorDeduccion: ActorDeduccion = { ...base, rol: 'titular' };
  const actorPlataforma: ActorPlataforma = {
    ...base,
    rol: 'titular',
    activo: true,
    estudioId: estudio.id,
  };

  // --- Estudio: la lista de precios -----------------------------------------
  // Va PRIMERO a propósito: la cascada de precios corre dentro del recompute, y
  // el recompute de cada obra pasa cuando se procesa su documento. Sembrar la
  // lista después dejaría la planilla sin precios hasta el próximo recompute.
  const actorPrecios: ActorPrecios = { ...base, rol: 'titular', activo: true, estudioId: estudio.id };
  const precios = await asegurarPrecios(db, actorPrecios);

  // --- Obra 1: el expediente y la bandeja -----------------------------------
  const { obra, creada: obraCreada } = await asegurarObra(db, estudio.id, OBRA);
  const subidos = await asegurarDocumentos(db, obra, usuario, DOCUMENTOS);
  const respondida = await asegurarConsultaRespondida(db, obra, usuario);
  const editado = await asegurarItemEditado(db, obra, usuario);

  // --- Obra 2: deducciones y compulsa ---------------------------------------
  const { obra: obraCompulsa, creada: obraCompulsaCreada } = await asegurarObra(
    db,
    estudio.id,
    OBRA_COMPULSA,
  );
  const subidosCompulsa = await asegurarDocumentos(db, obraCompulsa, usuario, DOCUMENTOS_COMPULSA);
  const validada = await asegurarDeduccionValidada(db, obraCompulsa, actorDeduccion);
  const agenda = await asegurarProveedores(db, estudio.id, actorProveedor);
  const lanzada = await asegurarCompulsa(db, obraCompulsa, actorCompulsa, agenda.porNombre);
  const cotizadas = await asegurarCotizaciones(db, obraCompulsa, actorCompulsa);
  const negociada = await asegurarNegociacion(db, obraCompulsa, actorCompulsa);

  // --- Obra 3: el expediente como conjunto -----------------------------------
  const { obra: obraConjunta, creada: obraConjuntaCreada } = await asegurarObra(
    db,
    estudio.id,
    OBRA_CONJUNTA,
  );
  const subidosConjunta = await asegurarDocumentos(db, obraConjunta, usuario, DOCUMENTOS_CONJUNTA);
  const alturaRespondida = await asegurarAlturaDeLocal(db, obraConjunta, usuario);

  // --- Plataforma -----------------------------------------------------------
  const codigo = await asegurarInvitacion(db, actorPlataforma);
  const avisos = await asegurarNotificaciones(db, usuario);

  const hechos = [
    estudio.creado ? `estudio «${ESTUDIO}»` : null,
    usuarioCreado ? `usuario ${USUARIO.email}` : null,
    obraCreada ? `obra «${OBRA.nombre}»` : null,
    obraCompulsaCreada ? `obra «${OBRA_COMPULSA.nombre}»` : null,
    obraConjuntaCreada ? `obra «${OBRA_CONJUNTA.nombre}»` : null,
    precios > 0 ? `${precios} renglones en la lista de precios del estudio` : null,
    subidos + subidosCompulsa + subidosConjunta > 0
      ? `${subidos + subidosCompulsa + subidosConjunta} ${subidos + subidosCompulsa + subidosConjunta === 1 ? 'documento subido y procesado' : 'documentos subidos y procesados'}`
      : null,
    respondida ? '1 consulta de escala respondida' : null,
    editado ? `1 ítem editado a mano (${EDICION.claveItem})` : null,
    validada ? `1 deducción validada (${DEDUCCION_A_VALIDAR.entidad}.${DEDUCCION_A_VALIDAR.campo})` : null,
    alturaRespondida
      ? `1 consulta de dato de obra respondida (altura_local.PB = ${ALTURA_DE_LOCAL.valor} m)`
      : null,
    agenda.creados > 0 ? `${agenda.creados} proveedores en la agenda (1 con opt-out)` : null,
    lanzada ? `1 compulsa de ${RUBRO_COMPULSA} lanzada a ${CONTACTADOS.length} proveedores` : null,
    cotizadas.registradas > 0
      ? `${cotizadas.registradas} cotizaciones conciliadas, ${cotizadas.repreguntas} repregunta(s) en borrador y ${cotizadas.muestras} muestra(s) del índice`
      : null,
    negociada ? '1 ronda de negociación propuesta' : null,
    codigo ? `1 invitación de colaborador vigente (código ${codigo})` : null,
    avisos > 0 ? `${avisos} notificaciones de muestra` : null,
  ].filter((linea): linea is string => linea !== null);

  console.log('');
  if (hechos.length === 0) {
    console.log('Seed: no había nada que hacer, los datos de demo ya estaban.');
  } else {
    console.log('Seed: se creó');
    for (const hecho of hechos) console.log(`  · ${hecho}`);
  }

  imprimirTabla(`Obra «${OBRA.nombre}» (${obra.id}):`, await contar(db, obra.id));
  imprimirTabla(
    `Obra «${OBRA_COMPULSA.nombre}» (${obraCompulsa.id}):`,
    await contar(db, obraCompulsa.id),
  );
  imprimirTabla(
    `Obra «${OBRA_CONJUNTA.nombre}» (${obraConjunta.id}):`,
    await contar(db, obraConjunta.id),
  );
  imprimirTabla('Compulsa y plataforma:', await contarCompulsa(db, obraCompulsa.id, estudio.id));

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
