# CLAUDE.md — tests

## Estructura

- `tests/unit/` — dominio puro (computo, rubros, hallazgos, presentacion, pdf utils). Sin DB, sin fs (salvo fixtures), sin red.
- `tests/integration/` — pipeline completo y API sobre PGlite **en memoria** (cada suite crea su DB con `createTestDb()`, nada persiste). Provider de análisis SIEMPRE mock.
- `tests/fixtures/` — PDFs sintéticos de prueba y fixtures JSON del provider mock (`analysis/<sha256|nombre>.json`).
- `tests/golden/` — el golden set: obras de referencia con su cómputo esperado (`obra-*/expected-computo.json`). `npm run golden` computa cada obra con el pipeline real (provider mock con fixtures completos) y reporta el error por ítem y global.

## Reglas

1. **Números concretos en los asserts.** `expect(items[0].cantCompra).toBe(4)` — no `toBeGreaterThan(0)`. Un test que no pinnea un valor no protege una decisión.
2. **Nada de red en tests.** Si un test necesita `ANTHROPIC_API_KEY`, está mal diseñado: usá el mock con fixture.
3. **El golden set es el contrato de precisión (RNF-1):** error global ≤ 2% por rubro contra el esperado. Si tu cambio lo rompe, el cambio está mal o el esperado está mal — decidilo explícitamente y dejalo escrito en el commit, nunca "ajustes" el esperado para que pase sin justificar.
4. Los PDFs de fixtures se generan con `tests/fixtures/make-fixtures.ts` (pdf-lib, determinístico) — no commitees PDFs binarios opacos bajados de internet.
5. Umbral verde: `npm test` sin fallos y `npm run golden` reportando error ≤ 2% en los rubros con golden. Los dos comandos, con salida a la vista, antes de declarar cualquier tarea terminada.
