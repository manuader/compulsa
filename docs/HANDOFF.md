# HANDOFF — Compulsa, estado actual

> **Banner:** **F0 + UI de gestión completas en `main`** (2026-08-26, commit efe5eb5, 273/273 tests). El **provider real de Claude ya corre en producción local**: el usuario está computando una obra real de 25 láminas con su API key — los rótulos reales se leen bien y el primer bug de producción (bbox inválido tiraba la lámina) está arreglado. Lo siguiente: acompañar la prueba real, paralelizar el pipeline (hoy secuencial), o F1.

## 0. Cómo usar este documento

Si sos un agente que llega: leé **este archivo y el más nuevo de `handoffs/`**. Dos documentos. Con eso sabés dónde están las cosas.

| Dónde | Qué va | Vida |
|---|---|---|
| este general | lo que sigue siendo cierto: arquitectura, reglas, decisiones cerradas, trampas pagadas, §4 | permanente, acumula |
| `docs/SESSION-<fecha>-<tema>.md` | el detalle de una sesión | permanente, no se edita después |
| `handoffs/HANDOFF-<fecha>-<tema>.md` | estado al cierre: qué quedó abierto | efímero, gitignoreado |

Al terminar: (1) session doc, (2) handoff, (3) **actualizar este archivo** — nueva entrada en §4 más lo que corresponda en §5, §7 y §9. El paso 3 es el que se saltea y el que sostiene el sistema.

Si encontrás acá algo que ya no es cierto, **corregilo**. Un general creído y equivocado es peor que ninguno.

## 1. Qué es esto

Compulsa: el arquitecto sube la documentación de una obra y recibe el cómputo por rubros en planillas con trazabilidad total al plano, la lista de lo que la documentación no resuelve (clasificado), y (en fases futuras) compulsas de precios lanzadas y comparadas. Stack: Next.js 15 + TypeScript + Tailwind + Drizzle sobre Postgres (PGlite en dev/test), providers de IA detrás de interfaz (mock/Claude). Estado: **F0 terminada**; F1–F4 pendientes (PRD §14).

## 2. Reglas del repo

Las operativas viven en `CLAUDE.md` (raíz) y en los CLAUDE.md por módulo (`src/db/`, `src/lib/computo/`, `src/lib/analysis/`, `src/app/`, `tests/`). Las tres que rompen todo si se ignoran: provenance obligatorio en datos generados, ningún dato inventado en silencio (taxonomía §11 del PRD), tests y build verdes antes de declarar nada terminado.

## 3. Arquitectura

- **Dominio puro** (`src/lib/computo`, `rubros`, `hallazgos`): sin I/O; testeable sin mocks. El pipeline y la UI dependen de él, nunca al revés.
- **Fronteras por interfaz:** análisis IA (`AnalysisProvider` mock/Claude en `src/lib/analysis`) y storage (`StorageAdapter` fs-local en `src/lib/storage`). El core no importa SDKs externos.
- **DB:** esquema Drizzle en español fiel al PRD §10 (subconjunto F0). Cliente singleton PGlite↔Postgres por `DATABASE_URL` (`src/db/client.ts`). Migraciones automáticas al boot.
- **Pipeline** (`src/lib/pipeline`): jobs idempotentes por lámina con estados persistidos (pendiente → procesando → analizada | bloqueada_escala | error), exclusión mutua por claim condicional + mapa en vuelo, recompute tolerante a fallos que audita todo. Comparaciones jsonb SOLO con `igualJson` canónico (`pipeline/json.ts`).
- **UI:** App Router, Server Components + Server Actions. Núcleos DB-mutantes en `src/lib/*` (nunca exportados desde archivos `'use server'`); wrappers `*Action` con `requireObra`. Contratos internos públicos: `?highlight=<id>` (planilla/bandeja → visor) y `?rubro=` (export).

## 4. Qué cambió, sesión por sesión

### Sesión 2026-08-26 — UI de gestión + estreno del provider real con obra verdadera
Se agregó la gestión completa (eliminar documentos con recompute, archivar/editar/eliminar obras con type-to-confirm server-side, toggle archivadas, redirect auth, filenames de export distinguidos; núcleo en `src/lib/obras/gestion.ts`). En paralelo, el usuario activó su API key y subió una obra real de 25 láminas: los rótulos se leyeron bien y apareció el primer bug de producción — la gramática de structured outputs no garantiza largos de array y un bbox de 3 elementos tiraba la lámina entera; se arregló con schema de cable laxo + saneo por entidad (`sanearAnalisis`). Detalle: [SESSION-2026-08-26-gestion-y-provider-real.md](SESSION-2026-08-26-gestion-y-provider-real.md).

### Sesión 2026-08-25 — F0 completa: de repo vacío a producto funcional mergeado
Se instaló el sistema de handoffs, se escribió el plan de 11 tareas y se ejecutó entero por subagentes con revisión por tarea (5/11 con ronda de fixes) + revisión final de rama que encontró 3 defectos cross-tarea (auditorías fantasma por orden de claves jsonb, núcleos de bandeja expuestos en `'use server'`, bloqueantes rubro-null que no gateaban) — todos cerrados en una ola final. Cierre: 252/252 tests, golden 0,00 %, e2e 9/9 en navegador. Detalle y hallazgos: [SESSION-2026-08-25-f0-nucleo.md](SESSION-2026-08-25-f0-nucleo.md).

## 5. Decisiones no re-litigables

1. **PGlite + adaptadores locales en vez de Supabase real en F0** — sin Docker ni Supabase CLI en la máquina y MCP sin autenticar; PGlite da Postgres real con el MISMO esquema, y el cambio a Supabase es `DATABASE_URL` + adapter de storage + RLS, no una reescritura.
2. **Auth propio mínimo (scrypt + cookie httpOnly + tabla sesiones)** — Supabase Auth requiere el servicio real; la interfaz (`getSession`/`requireUser`/`requireObra`) es lo que la app consume.
3. **Provider mock determinístico como default y único en tests** — sin red ni API key en tests; la calidad del modelo real se mide aparte con el golden cuando haya key. Clave de fixture: `slug(documentoNombre)-p<página>` — **no hash de bytes**: pdf-lib re-serializa con fechas y el hash no es estable.
4. **Identificadores de dominio en español, fieles al PRD §10.**
5. **Rubros como datos** (`src/lib/rubros/`): agregar un rubro no toca el engine.
6. **El golden se deriva a mano, jamás corriendo el pipeline** — un esperado generado por lo que se testea se aprueba solo. Si el golden falla, se investiga qué lado está mal; no se "ajusta".
7. **Núcleos DB-mutantes nunca en archivos `'use server'`** — todo export de esos archivos es endpoint público HTTP. Patrón: núcleo en `src/lib/*`, wrapper `*Action` guardado.
8. **Worker de pdf.js = copia estática commiteada en `public/pdf.worker.min.mjs`** (hash verificado contra pdfjs-dist 4.10.38) — `new URL(..., import.meta.url)` no compila con pdfjs en `serverExternalPackages`.
9. **F0 no incluye** deducciones (F2), capas de anotación (F2), RFQ/outreach (F1), DWG (F4) — PRD §14; no adelantar alcance.
10. **Borrar obra = archivar; el borrado físico existe solo sobre archivadas** con confirmación del nombre validada en el server, y purga todo incluida la auditoría de la obra dejando UNA fila `obra_eliminada` (obra_id null) — excepción documentada a la regla de soft-delete. La fila de rastro se escribe ANTES del barrido de storage (un EACCES no puede dejar una obra borrada sin rastro).
11. **El cable del LLM es laxo en lo numérico a propósito** (`zAnalisisLaminaCrudo` + `sanearAnalisis` en `src/lib/analysis/tipos.ts`): la gramática de structured outputs garantiza claves y enums pero no largos de array ni rangos; el contrato estricto se aplica por entidad (clamp de recuperables, descarte contado de inutilizables). El mock sigue estricto.

## 6. Cómo verificar

```bash
npm test          # 252 tests / 21 suites, todos verdes (~50 s con máquina quieta)
npm run golden    # tabla por rubro, 0,00 % en los 4; exit 1 si algún rubro > 2 %
npm run build     # 16 rutas, sin errores (2 warnings preexistentes de pdfjs en texto.ts)
npm run seed      # idempotente; demo@compulsa.ar / demo1234
npm run dev       # :3000 — NO correr build con dev levantado (comparten .next/)
```

Orden: test → golden → build. Con agentes/procesos pesados activos en la máquina los tests de integración (PGlite por test) dan timeouts falsos — verificar siempre con máquina quieta (§7.3).

## 7. Trampas en las que ya caímos

1. **No hay Docker ni Supabase CLI en esta máquina** (verificado 2026-08-25). No intentes `supabase start`.
2. **El hot-reload de Next duplica clientes de DB** — pasar siempre por el singleton `globalThis.__compulsaDb` de `src/db/client.ts`.
3. **Comparar jsonb con `JSON.stringify` crudo escribe ~50 auditorías fantasma por recompute**: Postgres reordena las claves. Usar `igualJson` de `src/lib/pipeline/json.ts`; hay test de regresión que lo protege.
4. **`pdfjs-dist@5.x` no importa en Node 21** (`process.getBuiltinModule` es Node ≥22.3) y arrastra `@napi-rs/canvas` (25 MB nativo) como optional dep. Está fijado 4.10.38 + override que bloquea el canvas; subir de major requiere subir Node primero.
5. **Corridas de verificación con otros agentes activos dan falsos rojos**: 7 tests "fallaron" por timeouts de contención de CPU y pasaban solos. Verificación final siempre con máquina quieta.
6. **`npm run build` con `dev` levantado corrompe `.next/`** — documentado en README.
7. **`npm run seed` necesita `process.exit()`**: la PGlite persistida deja vivo el event loop (falta `closeDb()` en client.ts).
8. **La gramática de structured outputs NO valida largos de array ni rangos numéricos**: un `bbox` de 3 elementos pasó la generación con documentación real y el schema estricto rechazaba la lámina completa. Por eso existe la decisión §5.11 — no "simplificar" volviendo al schema estricto en `zodOutputFormat`.
9. **Con la máquina cargada la suite necesita `npx vitest run --hookTimeout=120000`**: sin el flag caen ~6 suites por `Hook timed out` en `createTestDb` (cero asserts rotos). Para build con el dev server vivo: worktree detached (`git worktree add --detach .worktrees/buildcheck <sha>`), nunca en el checkout principal.

## 8. Qué falta

- **Deuda aceptada por la revisión final** (lista completa con razones al final de [SESSION-2026-08-25-f0-nucleo.md](SESSION-2026-08-25-f0-nucleo.md)); las dos para F1 temprano: unique `computo_items(obra_id, clave_item)` + índices FK, y columna `procesando_desde` en `laminas`.
- **Bloqueado en humanos:** credenciales Supabase/Vercel (deploy), obras reales del colega con cómputo manual para el golden real, respuestas del §18 del PRD. (`ANTHROPIC_API_KEY` ya está activa y el provider real corre — queda arreglar el cache que pisa `ObraContexto` en reformas.)
- **Paralelizar `procesarDocumento`** (hoy secuencial; 25 láminas reales se hacen largas) — cuidando la exclusión por lámina existente y el rate limit de la API.
- **F1 (compulsa integrada)** según PRD §14.

## 9. Mapa de documentos

| Doc | Responde |
|---|---|
| **este** | punto de entrada, estado, arquitectura |
| `doc/PRD.md` | el producto completo: módulos, RFs, modelo de datos, roadmap |
| `doc/IDEA.md` | el pitch / narrativa de producto |
| `docs/superpowers/plans/2026-08-25-compulsa-f0.md` | el plan de F0 tarea por tarea (ejecutado) |
| [SESSION-2026-08-25-f0-nucleo.md](SESSION-2026-08-25-f0-nucleo.md) | cómo se construyó F0, los bugs que valieron la plata, la deuda aceptada |
| `CLAUDE.md` + CLAUDE.md por módulo | reglas operativas de cada área |
| `README.md` | setup, comandos, arquitectura para humanos |
