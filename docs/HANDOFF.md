# HANDOFF — Compulsa, estado actual

> **Banner:** **Todo el PRD está implementado y mergeado en `main`** (2026-08-26, commit 9550dac): F0 cómputo + gestión + F1 compulsa + F2 deducción + F3 negociación/índice/ahorro + F4 plataforma. **962/962 tests · golden 2 casos 0,00 % · build verde · e2e de 9 bloques en navegador.** El provider real de Claude corre con la API key del usuario. Lo que falta no es código: son credenciales (Supabase/Vercel para deploy, WhatsApp/voz/mail para los canales) y obras reales para calibrar. Billing y DWG no se construyeron — decisión explícita, ver README «Lo que no está».

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

### Sesión 2026-08-26 (tarde) — F1 a F4: el resto del PRD
12 tareas (P1–P12) en olas paralelas: compulsa integrada (snapshot con hash, proveedores con import CSV, canal manual, conciliación línea por línea con score, repreguntas, conversaciones), deducción completa (5 reglas del §11, bandeja, memoria, planilla derivada), negociación con mandato, índice de precios, contador de ahorro, comparativa y adjudicación con orden de compra, y la plataforma (roles, invitaciones, config, checklists, notificaciones, auditoría). La revisión final de rama encontró tres defectos que ninguna revisión por tarea podía ver — `eliminarObra` destruía datos con obras que tenían compulsas, el loop de negociación nunca cerraba (el término de mejoras del ahorro era código muerto), y las sustituciones de spec eran invisibles en la pantalla de adjudicación — más una rotura introducida por el propio fix. Todo cerrado en dos rondas. Detalle: [SESSION-2026-08-26-f1-f4.md](SESSION-2026-08-26-f1-f4.md).

### Sesión 2026-08-26 (mañana) — UI de gestión + estreno del provider real con obra verdadera
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
12. **Los canales de outreach son adapters honestos**: manual es el único activo; WhatsApp/voz/mail lanzan `CanalNoConfiguradoError` nombrando la env var que falta. Nunca un no-op silencioso ni UI que simule un envío que no ocurre.
13. **El snapshot RFQ es el contrato inmutable** (RF-701): hash sha256 sobre el JSON canónico del cómputo aprobado; recompulsar = versión N+1 explícita que cierra la anterior.
14. **Conciliación por Jaccard ≥ 0,5**, no coeficiente de solapamiento: con solapamiento "durlock" matcheaba "placa de yeso".
15. **El ahorro se calcula on-read** (adjudicaciones + cotizaciones + negociaciones), sin tabla que se desincronice; y **`exigirCompulsaEnJuego` guarda toda escritura** sobre una compulsa ya adjudicada.

## 6. Cómo verificar

```bash
npx vitest run --hookTimeout=120000 --testTimeout=120000   # 962 tests / 60 suites (~5,5 min con máquina quieta)
npm run golden    # 2 casos (obra-demo, obra-reforma), 0,00 %; exit 1 si algún rubro > 2 %
npm run build     # sin errores (2 warnings preexistentes de pdfjs en texto.ts)
npm run seed      # idempotente; demo@compulsa.ar / demo1234 + todo F1–F4 sembrado
npm run dev       # :3000 — NO correr build con dev levantado (comparten .next/)
```

Orden: test → golden → build. Con agentes/procesos pesados activos en la máquina los tests de integración (PGlite por test) dan timeouts falsos — verificar siempre con máquina quieta (§7.5, §7.9).

## 7. Trampas en las que ya caímos

1. **No hay Docker ni Supabase CLI en esta máquina** (verificado 2026-08-25). No intentes `supabase start`.
2. **El hot-reload de Next duplica clientes de DB** — pasar siempre por el singleton `globalThis.__compulsaDb` de `src/db/client.ts`.
3. **Comparar jsonb con `JSON.stringify` crudo escribe ~50 auditorías fantasma por recompute**: Postgres reordena las claves. Usar `igualJson` de `src/lib/pipeline/json.ts`; hay test de regresión que lo protege.
4. **`pdfjs-dist@5.x` no importa en Node 21** (`process.getBuiltinModule` es Node ≥22.3) y arrastra `@napi-rs/canvas` (25 MB nativo) como optional dep. Está fijado 4.10.38 + override que bloquea el canvas; subir de major requiere subir Node primero.
5. **Corridas de verificación con otros agentes activos dan falsos rojos**: 7 tests "fallaron" por timeouts de contención de CPU y pasaban solos. Verificación final siempre con máquina quieta.
6. **`npm run build` con `dev` levantado corrompe `.next/`** — documentado en README.
7. **`npm run seed` necesita `process.exit()`**: la PGlite persistida deja vivo el event loop (falta `closeDb()` en client.ts).
8. **La gramática de structured outputs NO valida largos de array ni rangos numéricos**: un `bbox` de 3 elementos pasó la generación con documentación real y el schema estricto rechazaba la lámina completa. Por eso existe la decisión §5.11 — no "simplificar" volviendo al schema estricto en `zodOutputFormat`.
9. **Con la máquina cargada la suite necesita `npx vitest run --hookTimeout=120000 --testTimeout=120000`**: sin los flags caen suites enteras por `Hook timed out` en `createTestDb` (cero asserts rotos). La suite completa tarda ~5,5 min sola y **no tolera otra corriendo al lado**. Para build con el dev server vivo: worktree detached (`git worktree add --detach .worktrees/buildcheck <sha>`), nunca en el checkout principal.
10. **Next valida exports que `tsc` no ve**: un `'use server'` solo exporta funciones async; un `route.ts` solo verbos HTTP y opciones de segmento. Cualquier otra cosa compila, pasa los tests y **rompe el build**. Lo guarda `tests/unit/exports-de-next.test.ts`.
11. **`max: 1` en el pool de Postgres es load-bearing**, no una decisión de performance: es lo que hoy cierra la carrera de adjudicación, el read-modify-write del índice de precios y la invariante del último titular. Subir el pool exige antes los `FOR UPDATE` documentados.
12. **La cadena de borrado de `eliminarObra` se olvida sola.** Dos veces ya: `recomputos` y las siete tablas de compulsa. Toda tabla nueva que cuelgue de una obra va agregada ahí, o la purga explota a mitad (sin transacción) y destruye datos.
13. **Nunca `pkill -f "next dev"`**: mata también el dev server del usuario. Matá por PID.

## 8. Qué falta

**El PRD está completo; lo que falta no es alcance, es contacto con la realidad.**

- **Probarlo con una obra y proveedores reales** — es el paso de mayor valor. Ahí se calibran el matching de conciliación (Jaccard penaliza descripciones cortas del proveedor) y los textos del gremio.
- **Deuda aceptada por la revisión final** (con razones, al final de [SESSION-2026-08-26-f1-f4.md](SESSION-2026-08-26-f1-f4.md)): `conciliarCotizacion` bajo `exigirCompulsaEnJuego` (riesgo residual nombrado), unificar las 4 copias de `requireRolCore`, mover los cores restantes fuera de `'use server'`, transacción en `adjudicarCompulsa`, doble conteo residual planta↔corte en tabique/muro/ambiente. De F0 quedan: paralelizar `procesarDocumento` (secuencial; 25 láminas reales se hacen largas), `closeDb()`, y el cache de `claude.ts` que pisa `ObraContexto` en reformas.
- **Bloqueado en credenciales del dueño:** Supabase/Vercel (deploy + RLS), WhatsApp/voz/mail (los adapters están escritos, faltan las llaves), obras reales con cómputo manual para un golden real, respuestas del §18 del PRD.
- **No construido por decisión explícita:** billing (Mercado Pago) y DWG/DXF — requieren cuentas y servicios inexistentes acá; ver README «Lo que no está».

## 9. Mapa de documentos

| Doc | Responde |
|---|---|
| **este** | punto de entrada, estado, arquitectura |
| `doc/PRD.md` | el producto completo: módulos, RFs, modelo de datos, roadmap |
| `doc/IDEA.md` | el pitch / narrativa de producto |
| `docs/superpowers/plans/2026-08-25-compulsa-f0.md` | el plan de F0 tarea por tarea (ejecutado) |
| `docs/superpowers/plans/2026-08-26-compulsa-f1-f4.md` | el plan de F1–F4 con todas las fórmulas pinneadas (ejecutado) |
| [SESSION-2026-08-26-f1-f4.md](SESSION-2026-08-26-f1-f4.md) | cómo se construyó el resto del PRD, los 3 bugs de rama entera y la deuda aceptada |
| [SESSION-2026-08-26-gestion-y-provider-real.md](SESSION-2026-08-26-gestion-y-provider-real.md) | gestión de obras/documentos y el estreno del provider real |
| [SESSION-2026-08-25-f0-nucleo.md](SESSION-2026-08-25-f0-nucleo.md) | cómo se construyó F0, los bugs que valieron la plata, la deuda aceptada |
| `CLAUDE.md` + CLAUDE.md por módulo | reglas operativas de cada área |
| `README.md` | setup, comandos, arquitectura para humanos |
