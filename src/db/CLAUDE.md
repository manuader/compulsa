# CLAUDE.md — src/db

Esquema y acceso a datos. El modelo canónico es el §10 del [PRD](../../doc/PRD.md); acá vive el subconjunto de la fase activa. Nombres de tablas y columnas **en español, idénticos al PRD** — no los traduzcas ni los "mejores".

## Reglas

1. **Un solo cliente:** `getDb()` en `client.ts` devuelve un singleton. En dev/test usa PGlite (persistido en `data/pglite/`, o en memoria si `NODE_ENV=test`); si `DATABASE_URL` está definida usa Postgres real. Nunca instancies drivers en otro lado — el hot-reload de Next abre clientes duplicados si no pasás por el singleton global (`globalThis.__compulsaDb`).
2. **Migraciones:** tocaste `schema.ts` → corré `npm run db:generate` y commiteá el SQL de `drizzle/`. Las migraciones corren automáticamente al boot (`migrate()` dentro de `getDb()`). Jamás edites una migración ya commiteada; generá una nueva.
3. **Enums como pgEnum**, con los valores exactos del PRD (`tipo_obra`: `nueva|reforma|ampliacion`; `origen_item`: `explicito|deducido|supuesto`; `estado_reforma`: `existente|demoler|nueva|na`; etc.). El dominio TypeScript importa los tipos desde `schema.ts` — una sola fuente de verdad.
4. **`fuentes_json` es jsonb** con shape `Fuente[]` de `src/types/domain.ts` (`{ laminaId, bbox: [x, y, w, h] }`, bbox normalizado 0–1 sobre la lámina). Toda tabla generada por agentes la lleva (entidades, computo_items, hallazgos).
5. **Multi-tenant desde el día uno:** toda tabla de negocio referencia `obra_id` y las obras referencian `estudio_id`. Toda query de la app filtra por el estudio de la sesión — el aislamiento (RNF-4) hoy se garantiza en la capa de queries; al migrar a Supabase se agrega RLS con policies por `estudio_id` (las policies SQL viven en `drizzle/rls/` cuando llegue F4, no antes).
6. **Timestamps:** `created_at` con default `now()` en todas las tablas; `updated_at` solo donde hay edición (computo_items).
7. **Nada de deletes físicos** en datos de negocio: `computo_items.estado = 'anulado'`, `hallazgos.estado = 'descartado'`. La auditoría (`auditoria`) referencia registros que tienen que seguir existiendo.

## Trampas ya pagadas

- PGlite no soporta múltiples conexiones al mismo directorio de datos: si ves `PGlite is already running`, hay dos procesos dev abiertos.
- `drizzle-kit generate` necesita `drizzle.config.ts` apuntando a `src/db/schema.ts` con `dialect: 'postgresql'` — no uses `driver`, quedó deprecado.
