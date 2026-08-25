# Compulsa

Plataforma de análisis documental, cómputo y compulsa de obra para estudios de arquitectura
argentinos. Subís la documentación de una obra en PDF, el sistema la analiza lámina por lámina
(con provenance: cada dato apunta a su lámina y su recuadro), arma el cómputo por rubro y deja
en una bandeja de consultas todo lo que no pudo deducir sin inventar.

El documento rector del producto es [doc/PRD.md](doc/PRD.md); las reglas de trabajo del repo
están en [CLAUDE.md](CLAUDE.md).

## Setup

Requiere **Node 21** y npm. No hace falta Docker ni ningún servicio externo: en desarrollo y en
tests la base corre sobre PGlite (Postgres embebido) y el análisis usa un provider mock.

```bash
npm install
cp .env.example .env.local   # opcional: todo tiene default offline
npm run dev
```

### Sin dependencias nativas

El árbol no compila ni descarga binarios nativos propios. `pdfjs-dist` declara `@napi-rs/canvas`
(≈25 MB) como `optionalDependency` para rasterizar páginas; acá sólo se extrae texto, así que el
`overrides` de `package.json` lo apunta a una versión inexistente y npm, al ser opcional, la saltea.
No lo agregues: si algún día hace falta rasterizar, revisá primero la nota de `pdfjs-dist` en
`.superpowers/sdd/2026-08-25-compulsa-f0/task-1-report.md`.

## Comandos

```bash
npm run dev          # dev server
npm run build        # build de producción
npm start            # sirve el build
npm test             # vitest (unit + integration)
npm run test:watch   # vitest en watch
npm run db:generate  # drizzle-kit generate (tras tocar src/db/schema.ts)
npm run seed         # datos de demo
npm run golden       # harness de regresión de precisión
npm run fixtures     # regenera los PDFs y fixtures de prueba
```

## Arquitectura

Next.js 15 (App Router) + React 19 + TypeScript estricto + Tailwind v4. El dominio de cómputo
(`src/lib/computo`, `src/lib/rubros`, `src/lib/hallazgos`) es puro y sin I/O. La IA y el storage
entran por interfaz (`src/lib/analysis`, `src/lib/storage`), con implementación mock/local y
real. Los datos van por Drizzle sobre PGlite o Postgres según `DATABASE_URL`.
