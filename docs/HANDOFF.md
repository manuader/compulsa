# HANDOFF — Compulsa, estado actual

> **Banner:** Proyecto recién arrancado (2026-08-25). El PRD v2 está cerrado en `doc/PRD.md`. Se está construyendo la **F0** (núcleo de cómputo) según el plan `docs/superpowers/plans/2026-08-25-compulsa-f0.md`. Sin Supabase real todavía: corre sobre PGlite + adaptadores locales por decisión registrada en §5.

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

Compulsa: el arquitecto sube la documentación de una obra y recibe el cómputo por rubros en planillas con trazabilidad total al plano, la lista de lo que la documentación no resuelve (clasificado), y (en fases futuras) compulsas de precios lanzadas y comparadas. Stack: Next.js 15 + TypeScript + Tailwind + Drizzle sobre Postgres (PGlite en dev/test), providers de IA detrás de interfaz (mock/Claude). Estado: F0 en construcción.

## 2. Reglas del repo

Las operativas viven en `CLAUDE.md` (raíz) y en los CLAUDE.md por módulo (`src/db/`, `src/lib/computo/`, `src/lib/analysis/`, `src/app/`, `tests/`). Las tres que rompen todo si se ignoran: provenance obligatorio en datos generados, ningún dato inventado en silencio (taxonomía §11 del PRD), tests y build verdes antes de declarar nada terminado.

## 3. Arquitectura

- **Dominio puro** (`src/lib/computo`, `rubros`, `hallazgos`): sin I/O; testeable sin mocks. El pipeline y la UI dependen de él, nunca al revés.
- **Fronteras por interfaz:** análisis IA (`AnalysisProvider` mock/Claude) y storage (`StorageAdapter` fs-local/Supabase). El core no importa SDKs externos.
- **DB:** esquema Drizzle en español fiel al PRD §10 (subconjunto F0). Cliente singleton PGlite↔Postgres por `DATABASE_URL`. Migraciones automáticas al boot.
- **Pipeline** (`src/lib/pipeline`): jobs idempotentes por lámina con estados persistidos (pendiente → procesando → analizada | bloqueada_escala | error); reintentable manualmente. Trigger.dev/Inngest quedan para cuando haya deploy real.
- **UI:** App Router, Server Components + Server Actions; acoplamiento visor↔planilla por query param `highlight` (contrato público interno).

## 4. Qué cambió, sesión por sesión

### Sesión 2026-08-25 — Fundación: documentación, plan F0 y arranque de implementación
Se instaló el sistema de handoffs, se escribieron los CLAUDE.md rectores, y se armó el plan completo de F0 (`docs/superpowers/plans/2026-08-25-compulsa-f0.md`) con 11 tareas en olas paralelizables. Implementación por subagentes (Opus) con revisión por tarea. Ver session doc al cierre.

## 5. Decisiones no re-litigables

1. **PGlite + adaptadores locales en vez de Supabase real en F0** — porque en el entorno de desarrollo no hay Docker ni Supabase CLI y el MCP de Supabase no está autenticado; PGlite da Postgres real embebido con el MISMO esquema Drizzle, así el proyecto corre y se testea completo hoy, y el cambio a Supabase es `DATABASE_URL` + adapter de storage + RLS, no una reescritura.
2. **Auth propio mínimo (scrypt + cookie de sesión httpOnly) en F0** — porque Supabase Auth requiere el servicio real; la interfaz (`getSession()`, `requireUser()`) es lo que la app consume, y se reimplementa sobre Supabase Auth sin tocar páginas.
3. **Provider de análisis mock determinístico como default y único en tests** — porque los tests no pueden depender de red ni de una API key, y el pipeline entero (estados, provenance, bloqueos de escala) es lo que hay que garantizar; la calidad del modelo real se mide aparte con el golden set cuando haya key.
4. **Identificadores de dominio en español, fieles al PRD §10** — porque el PRD es el contrato y las traducciones a mitad de camino generan dobles nombres (ya pasó en proyectos hermanos con `works`/`obras`).
5. **Rubros como datos, no como código** (plantillas + checklists en `src/lib/rubros/`) — porque "cualquier rubro" es inabarcable (riesgo declarado del PRD §17) y el diseño tiene que permitir agregar rubros sin tocar el engine.
6. **F0 no incluye:** deducciones automáticas (F2), capas de anotación sobre el visor (F2), snapshots RFQ/outreach (F1), DWG (F4). Está en el PRD §14; no adelantar alcance.

## 6. Cómo verificar

```bash
npm test          # esperado: todas las suites verdes (número exacto en el handoff más nuevo)
npm run build     # esperado: build sin errores ni warnings de tipos
npm run golden    # esperado: error ≤ 2% por rubro contra el golden set
npm run dev       # levanta en :3000; login demo@compulsa.ar / demo1234 tras npm run seed
```

Orden: `npm test` antes que `build` (los tests compilan más rápido y fallan más claro). El golden requiere fixtures del seed — corré `npm run seed` si da vacío.

## 7. Trampas en las que ya caímos

1. **No hay Docker ni Supabase CLI en esta máquina** (verificado 2026-08-25: daemon no responde, `supabase` no instalado). No intentes `supabase start`; es la razón de la decisión §5.1.
2. **El hot-reload de Next duplica clientes de DB.** PGlite falla con `already running` si se instancia fuera del singleton `globalThis.__compulsaDb` de `src/db/client.ts`.

## 8. Qué falta

- Ejecutar el plan F0 completo (tareas 1–11, ver plan y el handoff más nuevo para el estado real).
- Bloqueado en humanos: credenciales de Supabase/Vercel para deploy real; API key de Anthropic para el provider real; las 2–3 obras reales del colega con cómputo manual (golden set real — hoy el golden es sintético); respuestas del §18 del PRD.
- F1–F4 según roadmap del PRD §14.

## 9. Mapa de documentos

| Doc | Responde |
|---|---|
| **este** | punto de entrada, estado, arquitectura |
| `doc/PRD.md` | el producto completo: módulos, RFs, modelo de datos, roadmap |
| `doc/IDEA.md` | el pitch / narrativa de producto |
| `docs/superpowers/plans/2026-08-25-compulsa-f0.md` | el plan de implementación de F0, tarea por tarea |
| `CLAUDE.md` + CLAUDE.md por módulo | reglas operativas de cada área |
