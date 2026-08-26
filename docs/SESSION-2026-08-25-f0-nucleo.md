# SESSION 2026-08-25 — F0 completa: núcleo de cómputo

Una sola sesión llevó el repo de "dos markdown en doc/" a la F0 funcional mergeada en `main` (66 commits). Desarrollo por subagentes (implementadores Opus, revisores Sonnet, revisión final de rama en Fable) con revisión por tarea + ronda de fixes; olas paralelas en worktrees con paths disjuntos. Este doc registra lo que costó tiempo y no se deduce del código.

## Cómo terminó (números, no adjetivos)

- `npm test`: **252/252 en 21 suites**. `npm run golden`: **0,00 % de error** en los 4 rubros (15 ítems, esperado derivado a mano — el revisor de la Tarea 10 re-derivó los 15 de forma independiente y coincidieron). `npm run build`: 16 rutas. `tsc --noEmit` limpio.
- e2e: **9/9 pasos** verificados en navegador real (login → tablero → expediente → visor con overlay → planilla con edición inline y recálculo server-side → bandeja → aprobar rubro → export XLSX 200 con attachment → aislamiento entre estudios: 8 URLs ajenas, todas 404 sin filtrar el nombre).
- Cada tarea pasó por revisión independiente; 5 de 11 necesitaron ronda de fixes; la revisión final de rama encontró 3 Important nuevos que ninguna revisión por tarea podía ver (ver abajo) y una ola única los cerró.

## Los hallazgos que valieron la plata

1. **El recompute no era write-idempotente por el orden de claves de jsonb.** Postgres devuelve jsonb con claves ordenadas; el pipeline construía `Fuente` como `{laminaId, bbox, detalle}` y comparaba con `JSON.stringify` → `fuentes` siempre "difería". Un re-proceso byte-idéntico escribía **54 filas de auditoría fantasma** (45 `computo_item_actualizado` con antes==después). Lo encontró la revisión final por reproducción; el seed ya lo había *esquivado* sin reportarlo ("el reproceso dejaría auditorías nuevas") — moraleja: cuando un implementador rodea un comportamiento raro, ahí hay un bug. Fix: stringify canónico recursivo (`src/lib/pipeline/json.ts`) + test de regresión "cero diffs fantasma".
2. **`pdfjs-dist@5.6.205` no importa en Node 21** (`process.getBuiltinModule` es de Node ≥22.3): el paquete instalado por defecto jamás se pudo haber cargado, y además cargaba `@napi-rs/canvas` (25 MB nativo) como optional dep y tenía GHSA-hq66-cqwq-w95j. Fijado a 4.10.38 + override bloqueando el canvas. Encontrado porque la revisión de la Tarea 1 no le creyó al reporte del implementador.
3. **Bloqueantes con `rubro: null` (escala) no bloqueaban ningún rubro**: el gate filtraba por igualdad estricta de rubro. La demo del seed exhibía la contradicción (tablero decía "1 bloquea la aprobación" con todos los botones habilitados). Solo visible componiendo tareas — el gate (T3), el hallazgo de escala (T6) y la copy (T9/T11) eran correctos por separado.

## Diagnósticos equivocados que costaron tiempo

- **7 tests "fallando" tras el merge de la ola B eran contención de CPU**, no bugs: la Tarea 9 corría `npm ci`/build en paralelo en la misma máquina y las suites de integración (PGlite por test) excedían timeouts. La suite sola pasó 19/19. Regla derivada: nunca interpretar una corrida de verificación con agentes activos en la máquina.
- **El aislamiento por worktree del harness falló** ("not in a git repository") porque la sesión arrancó antes del `git init`. Se resolvió con worktrees manuales (`.worktrees/taskN`, gitignoreados) + merge del controller; los agentes corren `npm ci` en su worktree (~1 min con cache tibio).

## Decisiones que no hay que reabrir (además de §5 del general)

- **Claves de fixture del mock por `slug(nombre)-p<página>`, no por hash**: pdf-lib re-serializa con fechas al separar páginas; el hash de bytes no es estable.
- **Worker de pdf.js como copia estática commiteada en `public/`** (hash verificado contra el paquete): `new URL(..., import.meta.url)` no compila con pdfjs en `serverExternalPackages`.
- **El golden se deriva a mano, jamás corriendo el pipeline** — un esperado generado por el sistema que se testea es un test que se aprueba solo. La corrida roja con defectos deliberados quedó como suite.
- **Los núcleos que mutan DB no viven en archivos `'use server'`** (todo export de esos archivos es un endpoint público). Patrón del repo: núcleo en `src/lib/*` + wrapper `*Action` con `requireObra`. La bandeja lo violó y se corrigió; `crearObraCore` se defiende distinto (primer parámetro `Db` no serializable) y quedó documentado.

## Qué quedó deliberadamente afuera (con razón)

F1–F4 completos (RFQ/outreach, deducciones y capas, negociación/índice, SaaS) — roadmap del PRD §14. Doble pasada RF-306, Q&A RF-106 y versionado con diff RF-105 son P1, no F0. Deuda aceptada con veredicto explícito de la revisión final: timing side-channel del login, índices FK, unique de `computo_items(obra_id, clave_item)` (recomendado para F1 temprano), rescate TTL de láminas colgadas (pide columna `procesando_desde`), `ObraContexto` que no llega al prompt de Claude (cache por lámina lo pisa — afecta solo al provider real en reformas), seed idempotente por upload y no por completitud, XLSX por-rubro y consolidado con mismo filename, `/login` accesible con sesión, sin tests de render (jsdom pide tocar package.json congelado), `closeDb()` inexistente (el seed necesita `process.exit`).
