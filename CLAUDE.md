# CLAUDE.md — Compulsa

Plataforma de análisis documental, cómputo y compulsa de obra para estudios de arquitectura argentinos. El documento rector del producto es [doc/PRD.md](doc/PRD.md) (v2.0); el pitch está en [doc/IDEA.md](doc/IDEA.md).

## Protocolo de arranque y cierre (obligatorio)

Antes de empezar, leé `docs/HANDOFF.md` y el archivo más nuevo de `handoffs/`. Dos archivos: con eso sabés dónde está parado el proyecto.

Al terminar una sesión de trabajo: (1) escribí tu `docs/SESSION-<fecha>-<tema>.md`, (2) dejá tu `handoffs/HANDOFF-<fecha>-<tema>.md`, (3) **actualizá `docs/HANDOFF.md`** — el paso 3 es el que se saltea y el que sostiene todo el sistema.

## Qué es esto (una línea por fase)

- **F0 (actual):** núcleo de cómputo — crear obra, subir PDFs, pipeline de análisis, planilla de cómputo con provenance, bandeja de consultas, export XLSX.
- **F1:** compulsa integrada (snapshots RFQ, sourcing, outreach, conciliación, comparativa).
- **F2:** huecos y deducción completos (motor de reglas §11 del PRD, capas de anotación, amarillo/rojo).
- **F3:** negociación + índice de precios + contador de ahorro.
- **F4:** multi-estudio SaaS (billing, DWG, panel admin).

## Stack

- **Next.js 15 (App Router) + React 19 + TypeScript estricto + Tailwind CSS.**
- **Drizzle ORM** sobre Postgres. En desarrollo y tests corre **PGlite** (Postgres embebido, sin Docker); en producción, Postgres real / Supabase vía `DATABASE_URL`. El esquema es 100% portable a Supabase (RLS se agrega en deploy, ver `src/db/CLAUDE.md`).
- **Adaptadores, no dependencias directas:** storage (`src/lib/storage`) y análisis IA (`src/lib/analysis`) son interfaces con implementación local/mock y implementación real (Supabase Storage / Claude API). El core no importa SDKs de servicios externos.
- Tests con **Vitest**. PDF con **pdf-lib** (split) y **pdfjs-dist** (texto/render). XLSX con **exceljs**.

## Comandos

```bash
npm run dev          # dev server (PGlite local, migra al boot)
npm run build        # build de producción
npm test             # vitest (unit + integration)
npm run golden       # harness de regresión de precisión contra el golden set
npm run seed         # datos de demo (estudio + usuario demo@compulsa.ar / demo1234 + obra ejemplo)
npm run db:generate  # drizzle-kit generate (tras tocar src/db/schema.ts)
```

## Reglas del repo

1. **Idioma:** UI y textos de agentes en **es-AR** (vos, terminología local: durlock, corralón, DVH, premarco). Identificadores de dominio en español (siguen al PRD §10: `obras`, `laminas`, `computo_items`, `hallazgos`); código de infraestructura en inglés.
2. **Provenance no negociable (P1):** ningún dato generado por el sistema entra a la base sin `fuentes_json` (lámina + bbox normalizado) u origen declarado. Un `computo_item` sin fuente es un bug, no un detalle.
3. **Deducir, no inventar (P4):** el sistema jamás rellena un dato en silencio. Lo que no es explícito ni deducible con fuentes es un hallazgo en la bandeja. Nada estructural/de seguridad se auto-propone (RF-506).
4. **Toda escritura de agente se audita:** usar `registrarAuditoria()` (`src/lib/audit.ts`) en cada mutación hecha por pipeline o agentes, con actor y diff.
5. **TDD:** el dominio puro (`src/lib/computo`, `src/lib/rubros`, `src/lib/hallazgos`) se desarrolla test-first. Nada se declara terminado sin `npm test` y `npm run build` verdes, con la salida a la vista.
6. **No tocar los originales:** los archivos subidos son inmutables; derivados (láminas separadas, anotaciones) son archivos/registros nuevos.
7. **CLAUDE.md por módulo:** cada área con reglas propias tiene su CLAUDE.md (`src/db/`, `src/lib/computo/`, `src/lib/analysis/`, `src/app/`, `tests/`). Leé el del área que vas a tocar antes de editar.
8. Secretos solo por variables de entorno (`.env.local`, nunca commiteado). `ANTHROPIC_API_KEY` habilita el provider real de análisis; sin la key, el sistema usa el provider mock determinístico (los tests SIEMPRE usan mock).

## Mapa del código

| Área | Qué es |
|---|---|
| `src/db/` | esquema Drizzle, cliente (PGlite/Postgres), migraciones |
| `src/lib/computo/` | motor de cómputo puro: unidades, desperdicio, presentación comercial, sanity checks |
| `src/lib/rubros/` | plantillas y checklists por rubro (aberturas, seco, pintura, gruesa) |
| `src/lib/hallazgos/` | taxonomía de huecos (§11 PRD) y gate de aprobación |
| `src/lib/analysis/` | providers de IA (mock/Claude): rótulos, entidades, con provenance |
| `src/lib/pdf/` | split de PDFs, extracción de texto, raster |
| `src/lib/pipeline/` | orquestación del análisis por lámina/obra (idempotente, con estados) |
| `src/lib/export/` | export XLSX |
| `src/lib/auth/`, `src/lib/storage/`, `src/lib/audit.ts` | sesiones, archivos, auditoría |
| `src/app/` | pantallas del workspace + API routes |
| `tests/` | unit, integration, fixtures y golden set |
