# El expediente como conjunto — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el análisis lea el expediente como conjunto (spec: `docs/superpowers/specs/2026-08-28-expediente-como-conjunto-design.md`): pipeline por fases con extracción en paralelo y cruce global, datos de obra compartidos, niveles de evidencia (explícito/deducido/inferido/pregunta) que entran directo marcados, precios estimados del estudio, y 4 rubros nuevos (terminaciones, sanitaria, eléctrica, demolición).

**Architecture:** La misma: dominio puro en `src/lib/*`, providers por interfaz con mock determinístico, núcleos DB-mutantes fuera de `'use server'`, todo auditado. La pieza nueva central **recicla el rail existente**: `deducciones` + `aplicarDeduccionesValidadas` + `CamposDeducidos` — lo que cambia es que las deducciones confiables nacen auto-validadas (reversibles) y que el mapa de campos lleva el origen.

**Tech Stack:** el existente, **sin dependencias nuevas** (package.json congelado). El pool de paralelismo se escribe a mano (~30 líneas).

## Global Constraints

- Todo lo vigente: es-AR voseo, provenance P1 (nada sin `fuentes_json` u origen declarado), auditoría en toda mutación de agente, TDD con números pinneados, tests offline (mock SIEMPRE), `igualJson`/`canonicalizar` para jsonb, regla 9 de exports de Next (`tests/unit/exports-de-next.test.ts` la guarda).
- **P4 reinterpretado por decisión de producto (spec §3.2):** lo deducido/inferido CON fuente o método entra directo al cómputo, marcado y reversible. Lo que NO cambia: nada sin fuente ni método, nada fuera de `CAMPOS_DEDUCIBLES` (RF-506), y la IA **jamás** pone un precio.
- **El dev server del usuario corre sobre el checkout principal**: tareas en worktrees `.worktrees/taskN`; jamás `npm run build`/`seed` en el checkout principal; **jamás `pkill`** (mata PGlite sin recuperación — matar por PID y solo procesos propios). Suite con `--hookTimeout=120000 --testTimeout=120000` en máquina cargada.
- Enums de Postgres: valores nuevos SIEMPRE al final de la lista (`ALTER TYPE … ADD VALUE`); reordenar rompe la migración sobre datos vivos.
- Los goldens 1 y 2 solo cambian de expected donde este plan lo dice (T12); cualquier otro movimiento se investiga, jamás se ajusta.
- `hallazgos.target_ref` se lee SOLO con `camposDelTarget()`; `normalizarTag` vive en `src/lib/computo/tags.ts` (hoja sin imports — no lo importes desde reglas de deducción).

## Contratos compartidos nuevos (a `src/types/domain.ts` en T1, VERBATIM)

```ts
export type Origen = 'explicito' | 'deducido' | 'supuesto' | 'inferido';   // ORIGENES: append 'inferido'
export type RubroId = 'aberturas' | 'seco' | 'pintura' | 'gruesa' | 'terminaciones' | 'sanitaria' | 'electrica' | 'demolicion'; // RUBROS: append los 4
export type TipoEntidad = /* existentes */ | 'tramo' | 'accesorio' | 'boca'; // TIPOS_ENTIDAD: append tras 'cota'
export type ReglaDeduccion = /* existentes */ | 'cruce' | 'medicion_grafica'; // REGLAS_DEDUCCION: append

/** Un hecho que vale para toda la obra. Clave convencional: `altura_local.PB`, `nivel.PB`, `altura_revestimiento.general`. */
export interface DatoObraValor { valor: number | string; unidad?: Unidad }
export interface DatoObraResuelto { clave: string; valor: number | string; unidad?: Unidad; origen: Origen; fuentes: Fuente[]; confianza: number; metodo?: string }

/** Un hallazgo puede apuntar a un dato de obra en vez de a una entidad. Responderlo escribe `datos_obra` y el recompute propaga. */
export interface TargetDato { clave: string; unidad?: Unidad; entidades: string[] }  // entidades = ids afectadas (informativo, para la tarjeta)

export interface PrecioEstimado { unitario: number; moneda: string; fuente: 'manual' | 'lista' | 'indice'; fechaPrecio: string }

/** Fase del análisis en curso, para la UI del expediente (`obras.analisis_json`). */
export interface FaseAnalisis { fase: 'inventario' | 'extraccion' | 'cruce' | 'relectura' | 'listo' | 'error'; total?: number; completadas?: number; detalle?: string }
```

`HallazgoDetectado` gana `targetDato?: TargetDato`. Zod: `zDatoObraValor`, `zTargetDato`, `zPrecioEstimado` alineados vía `_SchemasAlineados`. Atributos convencionales nuevos (comentario en domain.ts): `ambiente` += `nivel?, solado?, zocalo?, cielorraso?, revestimiento?, alturaRevestimientoM?`; `tramo`: `sistema ('af'|'ac'|'cloacal'|'pluvial'), diametro (string, ej. "20", "110"), longitudM?, material?`; `accesorio`: `tipo ('codo90'|'codo45'|'te'|'valvula'), sistema, diametro`; `boca`: `tipo ('toma'|'luz'|'caja'|'tablero'|'datos'), circuito?`.

## Fórmulas y valores pinneados (fuente de verdad para todos los tasks)

- **Auto-validación:** deducción determinista o de cruce con `confianza ≥ 0,7` (el `UMBRAL_DEDUCCION` existente) nace `estado='validada', validado_por=null` y se aplica en la misma corrida; `< 0,7` nace `propuesta` como hoy. `medicion_grafica` se auto-valida SIEMPRE por regla propia, con `confianza = 0,5` fija — pero su ítem sale `origen='inferido'`.
- **Origen por campo → origen del ítem:** `CamposDeducidos` pasa de `Map<entidadId, Set<campo>>` a `Map<entidadId, Map<campo, Origen>>`. El ítem sale con el peor origen de sus campos usados: `explicito < supuesto < deducido < inferido`. Pin: campos `{largoM: explicito, alturaM: deducido}` ⇒ ítem `deducido`; `{alturaM: inferido}` ⇒ `inferido`.
- **Medición gráfica:** `medidaGrafica(bbox, paginaPts: {ancho, alto}, escala: '1:N') → {anchoM, altoM}` con `metros = pts/72 × 0,0254 × N`. Pin: bbox `[0.1, 0.1, 0.5, 0.2]`, página 842×595 pts, escala `1:50` ⇒ anchoM **7,43**, altoM **2,10** (redondear2). Escalas admitidas: la confirmada o la declarada-asumida de la lámina; sin escala ⇒ no se mide. Solo tipos `muro|tabique|ambiente` y solo campos `largoM|alturaM|superficieM2` ausentes.
- **Cadena de respaldo de un campo de medida en plantillas:** atributo de la entidad (con su origen por campo) → dato de obra que aplique (su origen y sus fuentes se suman al ítem) → hallazgo. Datos de obra que las plantillas consultan: `alturaM` de tabique/muro/ambiente ← `altura_local.<atributo nivel de la entidad, o 'general'>`; `alturaRevestimientoM` ← `altura_revestimiento.<nombre ambiente, o 'general'>`.
- **Deduplicación de preguntas:** si a ≥ 1 entidades les falta el mismo dato de obra y no hay dato resuelto, la plantilla emite UN hallazgo `clave = dato_obra.<claveDato>` (ej. `dato_obra.altura_local.PB`), `targetDato: {clave, unidad: 'm', entidades: [ids]}`, descripción que enumera afectados (`enumerar()` del motor). Pin: 4 tabiques PB sin altura ⇒ 1 hallazgo, no 4; responderlo con 2,6 ⇒ recompute computa los 4 con origen `deducido`... **no**: origen `explicito` (lo cargó el usuario) y fuente = origen declarado del dato.
- **Cruce:** salida saneada con referencias por **código de lámina** resueltas a ids; se descarta (y cuenta) todo campo fuera de `CAMPOS_DEDUCIBLES`, código irresoluble, valor no numérico en campo de medida, confianza fuera de [0,1]. Claves de conflicto estables: `cruce.conflicto.<sha256(campo + fuentes ordenadas).slice(0,8)>`. Datos de obra del cruce: upsert solo si no hay fila con `definido_por` y solo `confianza ≥ 0,7` (bajo eso ⇒ deducción `propuesta` en revisión). Aplicar el MISMO resultado dos veces = cero diffs (idempotencia por `igualJson`).
- **Precios (cascada, puro):** precio manual del ítem → `precios_referencia` del estudio por `clave_item` exacta → índice `p50` del mes más reciente con `n ≥ 1` (misma zona de la obra) → `null`. Pin: manual 100, lista 90, índice 80 ⇒ 100; sin manual ⇒ 90; solo índice ⇒ 80; nada ⇒ null. `computo_items.precio_json: PrecioEstimado | null`, recalculado en cada recompute (un ítem editado por usuario conserva su precio manual).
- **Pool:** `enParalelo(items, cap, fn)` — cap **4** (`PARALELISMO_ANALISIS`, env override), preserva orden del resultado, un rechazo no tira el lote (se devuelve por ítem como settled). Pin: 10 items cap 4 ⇒ nunca más de 4 en vuelo (contador en test).
- **Claves de ítem nuevas:** `terminaciones.solado.<slug material>` (m², desperdicio 10), `terminaciones.zocalo.<slug>` (ml, 5), `terminaciones.cielorraso.<slug>` (m², 12), `terminaciones.revestimiento.<slug>` (m², 10), `terminaciones.contrapiso` (m², 0), `terminaciones.carpeta` (m², 0); `sanitaria.canieria.<sistema>.<diametro>` (ml, 5, tira de 4 m — pin: 6,5 ml ⇒ 2 tiras), `sanitaria.accesorio.<tipo>.<diametro>` (u, 0), `sanitaria.artefacto.<slug>` (u, 0); `electrica.boca.<tipo>` (u, 0); `demolicion.muros` (m², 0), `demolicion.carpinterias` (u, 0), `demolicion.solados` (m², 0). Diámetro normalizado: minúsculas, sin `ø`, sin unidad ("Ø110" ⇒ "110").
- **Pins de rubros:** ambiente 12 m² / perímetro 14 / solado "porcelanato" / zócalo "madera" ⇒ solado 12 m² + zócalo 14 ml + contrapiso 12 + carpeta 12; revestimiento "cerámica" en baño perímetro 10 × alturaRevestimientoM 2 ⇒ 20 m²; tramos ac Ø20 de 2 + 3 + 1,5 ⇒ `sanitaria.canieria.ac.20` cantNeta 6,5; 3 codo90 Ø20 + 1 te Ø20 ⇒ dos ítems u 3 y 1; artefacto "bacha" en ambiente sin tramo cloacal en el mismo ambiente ⇒ hallazgo `sanitaria.correspondencia.bacha` tipo inconsistencia NO bloqueante; 2 tomas + 3 luces ⇒ `electrica.boca.toma` 2 + `electrica.boca.luz` 3; muro demoler 4×2,6 ⇒ `demolicion.muros` 10,4 m² (altura por la misma cadena de respaldo).
- **Costos:** acciones de auditoría `analisis_llm` (existente), `inventario_llm`, `cruce_llm`, `busqueda_llm` (existente) — el costo por obra se responde sumando esas cuatro.

## Estructura de archivos nueva

```
src/lib/memoria/{compacta.ts,render.ts}                                   T2
src/lib/analysis/cruce-{tipos,mock,claude}.ts                             T3
src/lib/computo/medicion.ts · engine.ts (origen por campo)                T4
src/lib/precios/{resolver.ts,import-csv.ts,gestion.ts}                    T5
src/lib/rubros/{terminaciones,demolicion}.ts (+ seco/pintura/gruesa)      T6
src/lib/rubros/{sanitaria,electrica}.ts                                   T7
src/lib/analysis/{tipos,mock,claude,prompt}.ts (inventariar + tipos nuevos) T8
src/lib/pipeline/{pool.ts,cruce.ts} · procesar.ts (fases)                 T9
src/lib/pipeline/recomputar.ts (datos de obra + precios) · planilla UI    T10
src/lib/bandeja/** · src/app/obras/[obraId]/bandeja/** · expediente UI    T11
src/app/estudio/precios/** (T5) · /api/obras/[obraId]/memoria (T2)
tests/golden/obra-conjunta/** · seed · docs                               T12
```

---

### Tarea T1: Contratos, schema, stubs de rubro y migraciones (base serial)

**Files:** Modify `src/types/domain.ts`, `src/db/schema.ts`, `src/lib/analysis/prompt.ts` (ETIQUETA_RUBRO ×8), `src/lib/rubros/index.ts`, `src/lib/hallazgos/taxonomia.ts`; Create `src/lib/rubros/{terminaciones,sanitaria,electrica,demolicion}.ts` (STUBS honestos: `computar()` ⇒ `{items: [], hallazgos: []}` con TODO(T6/T7)), `drizzle/000X_*` (generada); Test `tests/integration/db-conjunto.test.ts`.
**Produces (interfaces que consumen T2–T11):** contratos VERBATIM de arriba; `PlantillaRubro.computar(entidades, tipoObra, laminas?, datosObra?)` con `datosObra?: ReadonlyMap<string, DatoObraResuelto>` (aditivo: plantillas existentes lo ignoran hasta T6); `ResultadoComputo` gana el miembro opcional `origenPorEntidad?: Map<string, Map<string, Origen>>` (qué campo de qué entidad se computó con qué origen — lo llenan las plantillas que usan respaldos, lo mergea el recompute con el mapa de deducciones); en taxonomia: `hallazgoDatoObraFaltante({rubro, claveDato, unidad, descripcion, entidades}): HallazgoDetectado` (clave `dato_obra.<claveDato>`, bloqueante false, `targetDato`) y `respaldoDeDatoObra(datosObra, clave): DatoObraResuelto | null`.
Schema: tabla `datos_obra(id, obra_id fk, clave, valor_json DatoObraValor, origen origen_item, fuentes_json Fuente[], confianza real, metodo text null, definido_por uuid null fk usuarios, updated_at, UNIQUE(obra_id, clave), index obra)`; tabla `precios_referencia(id, estudio_id fk, clave_item, descripcion, unidad unidad, precio numeric(14,2), moneda default 'ARS', fecha text, origen enum[csv|manual], UNIQUE(estudio_id, clave_item))`; `computo_items.precio_json jsonb null $type<PrecioEstimado>`; `hallazgos.target_dato jsonb null $type<TargetDato>`; `entidades.elemento_id uuid null` (sin FK: es un id de grupo); `obras.analisis_json jsonb null $type<FaseAnalisis>`. Enums: appends listados arriba (al FINAL de cada lista).
`eliminarObra` (src/lib/obras): sumar `datos_obra` a la cadena de borrado — test que una obra con datos_obra se elimina.
- [ ] Test primero (nuevas tablas + uniques + migración sobre DB con datos F0 no destruye), `npm run db:generate`, tsc a cero siguiendo los `satisfies` (ETIQUETA_RUBRO, PLANTILLAS, overrides/checklists si el compilador los exige), suite verde, commit.

### Tarea T2 (W1): Memoria de obra — compacta, render MD y route

**Files:** Create `src/lib/memoria/{compacta.ts,render.ts}`, `src/app/api/obras/[obraId]/memoria/route.ts` (GET only), `tests/unit/memoria.test.ts`, `tests/integration/memoria-route.test.ts`.
**Produces:** `type EntradaMemoria = { obra: {nombre, tipo}, laminas: Pick<Lamina, 'id'|'codigo'|'titulo'|'tipo'|'escala'|'escalaConfiable'|'estadoAnalisis'>[], entidades: EntidadPersistida[], datosObra: DatoObraResuelto[], deducciones: {campo, regla, confianza, estado, entidadNombre, laminaCodigo}[], hallazgosAbiertos: {clave, tipo, descripcion, bloqueante}[] }`; `memoriaCompacta(e: EntradaMemoria): string` (texto denso para el cruce: índice, entidades agrupadas por lámina con atributos en una línea, datos de obra, qué falta); `renderMemoriaMd(e: EntradaMemoria): string` (§27: DOCUMENTACIÓN ANALIZADA / DATOS DE OBRA / ELEMENTOS / RELACIONES Y DEDUCCIONES / CONFLICTOS / INFORMACIÓN FALTANTE / DATOS INFERIDOS con método). Ambas puras; la route arma `EntradaMemoria` desde la DB (requireObra) y responde `text/markdown; charset=utf-8` con `Content-Disposition` attachment.
- [ ] Pins: una entidad `tabique T1 {largoM: 4}` de lámina `A-01` aparece EXACTAMENTE como `- T1 (tabique): largoM=4` bajo `## A-01` en la compacta; el MD contiene las 7 secciones aunque estén vacías ("— nada registrado —"); route 200/401/404 cross-estudio.

### Tarea T3 (W1): Provider de cruce

**Files:** Create `src/lib/analysis/cruce-{tipos,mock,claude}.ts`, `tests/unit/cruce-tipos.test.ts`, dir `tests/fixtures/analysis/cruce/`.
**Produces:** en `cruce-tipos.ts` (puro, todo lo testeable acá): `interface CruceProvider { nombre: string; cruzar(memoria: string, ctx: ObraContexto): Promise<RespuestaCruceCruda> }`; wire laxo `zRespuestaCruceCruda { datosObra: {clave, valor: string, unidad?, laminaCodigo, bbox?, confianza}[], completados: {laminaCodigo, entidadNombre, campo, valor: string, fuenteLaminaCodigo, bbox?, confianza}[], identidades: {laminaCodigo, entidadNombre}[][], conflictos: {descripcion, datoA, laminaCodigoA, datoB, laminaCodigoB, causaPosible?}[], relecturas: {laminaCodigo, queBuscar}[] }` (valores string por el cable, coma decimal aceptada); `sanearCruce(crudo, ctx: {laminasPorCodigo: Map<string, string>, entidades: {id, laminaId, nombre, tipo}[]}): ResultadoCruce` que resuelve códigos→ids, matchea entidades por `(laminaId, normalizarTag(nombre))`, filtra `completados` a `esCampoDeducible(tipo, campo)`, convierte medidas con coma, clampa confianzas y cuenta descartados; `getCruceProvider()`.
Mock: fixture `tests/fixtures/analysis/cruce/<slug(obra.nombre)>.json` (mismo `slug` del mock de láminas); sin fixture ⇒ todo vacío. Claude: `messages.parse` patrón `busqueda-claude.ts` (SISTEMA es-AR: computista que cruza SOLO lo escrito, cita lámina por código, nunca estima; adaptive thinking; auditoría `cruce_llm` con tokens y conteos).
- [ ] Pins: completado de campo no deducible ⇒ descartado y contado; `laminaCodigo` desconocido ⇒ descartado; `"2,60"` en campo de medida ⇒ 2.6; identidad con una sola entidad resuelta ⇒ grupo descartado.

### Tarea T4 (W1): Medición gráfica + origen por campo en el engine

**Files:** Create `src/lib/computo/medicion.ts`, `tests/unit/medicion.test.ts`; Modify `src/lib/computo/engine.ts` (+ su test), `src/lib/pipeline/recomputar.ts` SOLO en `aplicarDeduccionesValidadas` (construcción del mapa con origen: regla `medicion_grafica` ⇒ `inferido`, el resto ⇒ `deducido`).
**Produces:** `medidaGrafica(bbox: BBox, paginaPts: {ancho: number, alto: number}, escala: string): {anchoM: number, altoM: number} | null` (null si la escala no parsea `1:N`); `type CamposDeducidos = ReadonlyMap<string, ReadonlyMap<string, Origen>>` y el engine calcula el origen del ítem con la precedencia pinneada (los tests existentes de `campo ∈ set ⇒ deducido` migran de shape sin cambiar de números).
- [ ] Pins: el de medidaGrafica de arriba (7,43 / 2,10); escala `"esc. gráfica"` ⇒ null; precedencia de origen; suite entera verde (nada más cambia de resultado).

### Tarea T5 (W1): Precios del estudio

**Files:** Create `src/lib/precios/{resolver.ts,import-csv.ts,gestion.ts}`, `src/app/estudio/precios/{page.tsx,ui.tsx,actions.ts}`, `tests/unit/precios.test.ts`, `tests/integration/precios.test.ts`.
**Produces:** `resolverPrecio(item: {claveItem, precioManual?: PrecioEstimado | null}, lista: Map<string, {precio, moneda, fecha}>, indice: {p50, mes, n} | null): PrecioEstimado | null` (cascada pinneada); `importarCsvPrecios(texto): {filas: {claveItem, descripcion, unidad, precio, fecha?}[], errores: {linea, motivo}[]}` (columnas `clave_item,descripcion,unidad,precio[,fecha]`, separador `,` o `;`, coma decimal en precio, unidad inválida = error de línea); `gestion.ts` núcleo CRUD + upsert por `(estudio, claveItem)` auditado, rol colaborador+. UI en `/estudio/precios`: tabla, alta manual, import con preview y errores por línea (patrón proveedores/importar), link desde la pantalla de estudio.
- [ ] Pins de cascada y de CSV (`;` con comillas; `"12,50"` ⇒ 12.5; línea con unidad `xx` reportada y no importada); integración: upsert idempotente.

### Tarea T6 (W1): Rubros terminaciones + demolición, y la cadena de respaldo en seco/pintura/gruesa

**Files:** Create `src/lib/rubros/terminaciones.ts`, `src/lib/rubros/demolicion.ts`, `tests/unit/rubro-terminaciones.test.ts`, `tests/unit/rubro-demolicion.test.ts`; Modify `src/lib/rubros/{seco,pintura,gruesa}.ts` + sus tests (reemplazan el stub de T1; `aberturas` no se toca).
**Key:** las tres plantillas existentes con campos de altura pasan del hallazgo-por-entidad a la cadena de respaldo: atributo → `respaldoDeDatoObra(datosObra, 'altura_local.<nivel|general>')` → si tampoco hay dato: UN `hallazgoDatoObraFaltante` por clave de dato (agrupando entidades), no uno por entidad. Implementación del respaldo: la plantilla completa el campo en una copia local de la entidad, le suma las `fuentes` del dato al ítem y reporta el campo en `ResultadoComputo.origenPorEntidad` (T1) con el origen del dato; el recompute mergea ese mapa con el de deducciones y el engine (T4) resuelve el origen del ítem. Checklists default de los rubros nuevos donde viven los existentes.
- [ ] Pins: los de terminaciones/demolición de arriba; seco con 4 tabiques sin altura + dato `altura_local.general` 2,6 origen deducido ⇒ `seco.placas` computa con origen ítem `deducido` y fuentes que incluyen la del dato; sin dato ⇒ UN hallazgo `dato_obra.altura_local.general` con `targetDato.entidades` de 4; pins existentes de seco/pintura/gruesa sin cambios de números.

### Tarea T7 (W1): Rubros sanitaria + eléctrica

**Files:** Create `src/lib/rubros/sanitaria.ts`, `src/lib/rubros/electrica.ts`, `tests/unit/rubro-sanitaria.test.ts`, `tests/unit/rubro-electrica.test.ts` (reemplazan stubs T1).
**Key:** claves y pins de arriba; diámetro normalizado; correspondencia §22: por cada `artefacto` en un `ambiente` (match por atributo `ambiente` del artefacto o bbox-en-lámina no: por atributo `ambiente` si está, si no se saltea el control — honesto), si no existe `tramo` de sistema `cloacal` con el mismo atributo `ambiente` ⇒ inconsistencia NO bloqueante; jamás se auto-crea el tramo. `boca.tablero` con cantidad > 1 en la misma lámina se suma igual (unidades).
- [ ] TDD con los pins; ambas plantillas ignoran `datosObra` (no tienen alturas).

### Tarea T8 (W1): Provider de láminas ampliado — `inventariar` + tipos nuevos en el prompt

**Files:** Modify `src/lib/analysis/{tipos.ts,mock.ts,claude.ts,prompt.ts}`, `tests/unit/analysis-prompt.test.ts`.
**Produces:** `AnalysisProvider.inventariar(lamina: LaminaInput): Promise<RotuloDetectado>` — prompt corto SOLO rótulo (sin entidades, sin ctx), llamada propia NO cacheada con `leerRotulo` (auditoría `inventario_llm`); mock: devuelve el rótulo del fixture (o vacío no confiable). `claude.ts`: el prompt de extracción aprende `tramo`/`accesorio`/`boca` con sus atributos exactos, los atributos nuevos de `ambiente` (cuadro de locales: una entidad `ambiente` por fila con terminaciones), y mantiene TODO lo vigente (planillas fila por fila, escala, P4). `prompt.ts`: nada más que ETIQUETA_RUBRO ya hecho en T1 — verificar que `textoInstrucciones` cubre los 8 rubros vía el test.
- [ ] Pins de prompt.ts (los existentes + instrucciones de un rubro nuevo etiquetadas); mock inventariar por fixture.

### Tarea T9 (W2, tras T1–T3, T4, T8): Pipeline por fases

**Files:** Create `src/lib/pipeline/{pool.ts,cruce.ts}`, `tests/unit/pool.test.ts`, `tests/integration/pipeline-fases.test.ts`; Modify `src/lib/pipeline/procesar.ts`, `src/lib/pipeline/busqueda.ts` (acepta objetivos extra del cruce), `src/lib/pdf/split.ts` (expone el tamaño de página en pts por lámina, para la medición gráfica).
**Key:**
- `pool.ts`: `enParalelo<T, R>(items: readonly T[], cap: number, fn: (item: T, i: number) => Promise<R>): Promise<Array<{ok: true, valor: R} | {ok: false, error: unknown}>>` — pin de cap.
- `procesar.ts`: (1) fase `inventario` — `enParalelo(paginas, 4, inventariar)` ⇒ persistir rótulos e índice ANTES de extraer, `obras.analisis_json` actualizado por fase; (2) fase `extraccion` — `enParalelo` sobre `procesarLamina` (el claim `reclamarLamina` existente hace de lock por lámina; el ctx lleva el índice completo desde la primera extracción); medición gráfica post-extracción: para entidades `muro|tabique|ambiente` con `largoM|alturaM|superficieM2` ausentes y escala utilizable ⇒ deducciones `medicion_grafica` auto-validadas (tamaño de página en pts sale del split de pdf-lib — exponerlo en `separarPaginas`); (3) fase `cruce` — `recomputarObra` (reglas §11; las ≥ 0,7 nacen validadas: función `estadoInicialDeduccion(confianza, regla)` en recomputar), luego `memoriaCompacta` ⇒ `getCruceProvider().cruzar` ⇒ `aplicarCruce(db, obraId, resultado)` en `cruce.ts`: datos_obra upsert (reglas pinneadas), completados ⇒ deducciones `regla='cruce'` (upsert por `(obra, entidad, campo)` sin pisar decididas) + aplicación, identidades ⇒ `elemento_id` compartido, conflictos ⇒ hallazgos, relecturas ⇒ objetivos extra; (4) fase `relectura` — `buscarDatosFaltantes` con los objetivos del cruce sumados; (5) recompute final + resumen + `analisis_json = {fase: 'listo'}`. Todo tolerante: una fase que falla deja `analisis_json {fase: 'error', detalle}` y NO tira lo ya persistido.
- [ ] Pins integración (obra fixture nueva `obra-fases` con planta + corte + fixture de cruce): tabiques computados `deducido` con fuente del corte; re-proceso completo ⇒ cero diffs fantasma (extender el set del test existente con las acciones nuevas); `analisis_json` pasa por las 5 fases; fixture de cruce ausente ⇒ pipeline termina igual (cruce vacío).

### Tarea T10 (W2, tras T1, T4–T7): Recompute con datos de obra y precios + planilla

**Files:** Modify `src/lib/pipeline/recomputar.ts` (cargar `datos_obra` ⇒ `Map<clave, DatoObraResuelto>` a las plantillas; mergear `origenPorEntidad` de plantillas con el mapa de deducciones; `resolverPrecio` por ítem con lista del estudio + índice de la zona/mes ⇒ `precio_json`), `src/app/obras/[obraId]/planilla/**` (columna precio con fuente/fecha + badges de origen `deducido`/`inferido` con tooltip de fuente/método + subtotal por rubro + total estimado), `src/lib/export/*` (columnas nivel de evidencia, fuente y precio; fila de totales), tests de integración.
- [ ] Pins: ítem con precio de lista ⇒ `precio_json.fuente='lista'` y subtotal correcto; ítem `inferido` con badge; export con las columnas nuevas; recompute idempotente (precio igual ⇒ cero updates, vía `igualJson`).

### Tarea T11 (W2/W3, tras T9 y T10): Bandeja de revisión + dato de obra + progreso del expediente

**Files:** Modify `src/lib/bandeja/resolver.ts` (+ actions/UI de bandeja), `src/lib/deduccion/persistencia.ts` (`rechazarDeduccion` sobre auto-validada ⇒ revierte el atributo — restaurar el `_valorDocumentado` si existe o borrar el campo — reabre el faltante vía recompute, auditado), `src/app/obras/[obraId]/bandeja/**` (solapas **Preguntas** —hallazgos abiertos— y **Para revisar** —deducciones `validada` con `validado_por IS NULL` + ítems `inferido`— con fuente/método visibles y botón «Rechazar»), tarjeta de dato de obra (`targetDato`: un input con unidad; responder ⇒ upsert `datos_obra` origen `explicito` `definido_por` usuario + recompute; el split-view resalta las fuentes de las entidades afectadas), `src/app/obras/[obraId]/expediente/**` (progreso por fase desde `obras.analisis_json`, polling suave), `/deducciones` redirige a la solapa Para revisar conservando el deep-link.
- [ ] Pins integración: responder `dato_obra.altura_local.general` ⇒ los 4 tabiques computan en UN recompute y la consulta cierra; rechazar una deducción de cruce auto-validada ⇒ atributo revertido + faltante reabierto + auditoría; RF-404: aprobar rubro exige cero bloqueantes y audita el conteo de deducidos/inferidos incluidos.

### Tarea T12 (final): Golden 3, goldens re-baseados, seed, e2e y docs

**Files:** Create `tests/golden/obra-conjunta/**` (fixtures: planta PB con 4 tabiques sin altura + corte con `altura_local` 2,60 + planilla de carpinterías + planta sanitaria con tramos/accesorios + cuadro de locales; fixture de cruce; expected con niveles de evidencia y UN hallazgo de dato de obra en cero tras responder — el harness corre el flujo completo); Modify goldens 1 y 2 SOLO si el nuevo default los mueve, con el diff justificado línea por línea en el commit (esperable en golden 2: la deducción `planilla_plano` ahora aplica sola); `scripts/seed.ts` (lista de precios demo ~10 renglones, obra demo con datos de obra y un rubro nuevo poblado); e2e con browser embebido en server propio (:3001): subir obra fixture ⇒ ver fases ⇒ planilla completa con precios y badges ⇒ bandeja con 1 pregunta de dato de obra ⇒ responder ⇒ propagación ⇒ rechazar una deducción ⇒ revert. Docs: CLAUDE.md raíz (mapa + fases), `src/lib/analysis/CLAUDE.md` (quinta familia + inventariar), `src/app/CLAUDE.md`, `tests/CLAUDE.md` (fixtures cruce + golden 3), HANDOFF general §4/§5/§7/§8 + session doc + handoff datado.
- [ ] Suite completa + `npm run golden` (3 casos) + build en worktree detached, todo verde con salida a la vista.

## Auto-revisión del plan

- **Cobertura del spec:** §5.1⇒T2 · §5.2⇒T1/T6/T10/T11 · §5.3⇒T3 · §5.4⇒T9 (estadoInicialDeduccion) + T11 (revert) · §5.5⇒T4/T9 · §5.6⇒T5/T10 · §5.7⇒T1/T6/T7/T8 · §5.8⇒T11 · §4 fases⇒T9 · §6 golden⇒T12 · criterios de aceptación 1–4⇒T12, 5⇒prueba manual post-merge con SEG2580.
- **Puntos de fricción conocidos:** dos tareas tocan `recomputar.ts` (T4 quirúrgico en `aplicarDeduccionesValidadas`; T10 amplio) — T10 va DESPUÉS de mergear T4, nunca en paralelo. `procesar.ts` es solo de T9. `taxonomia.ts` y `rubros/index.ts` son solo de T1. `busqueda.ts` solo de T9.
- **Tipos consistentes:** `DatoObraResuelto`/`TargetDato`/`PrecioEstimado`/`FaseAnalisis` nacen en T1 y todos los tasks los consumen por nombre exacto; `CamposDeducidos` cambia de shape en T4 y T6/T9/T10 usan el nuevo.
