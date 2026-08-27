# CLAUDE.md — tests

## Estructura

- `tests/unit/` — dominio puro (computo, rubros, hallazgos, presentacion, pdf utils). Sin DB, sin fs (salvo fixtures), sin red.
- `tests/integration/` — pipeline completo y API sobre PGlite **en memoria** (cada suite crea su DB con `createTestDb()`, nada persiste). Provider de análisis SIEMPRE mock.
- `tests/fixtures/` — PDFs sintéticos de prueba y fixtures JSON de los providers mock. La clave es **`slug(documentoNombre)-p<página>`**, nunca un hash de los bytes (pdf-lib re-serializa con fechas y el hash no es estable):
  - `analysis/<clave>.json` — rótulo y entidades de la lámina.
  - `analysis/busqueda/<clave>.json` — lo que la **búsqueda dirigida** encuentra en esa lámina (array de `{clave, campo, valor, bbox, confianza}`). Carpeta aparte, un nivel más abajo, para no colisionar con la familia de láminas. Pasa por `sanearBusqueda`, así que un fixture **no puede colar una clave ni un campo que la corrida no pidió**.
  - Dos PDFs que existen para un caso y no para otro: `escala-declarada.pdf` es el **único** fixture con escala declarada y `escalaConfiable: false` (sin él, que la escala asumida no bloquee no tendría red); `obra-busqueda.pdf` está armado para que la deducción `planilla_plano` **no** pueda disparar —una sola entidad FP01, no dos con el mismo tag en láminas distintas— así el único camino al dato es la búsqueda dirigida.
- `tests/golden/` — el golden set: obras de referencia con su cómputo esperado (`obra-*/expected-computo.json`). `npm run golden` computa cada obra con el pipeline real (provider mock con fixtures completos) y reporta el error por ítem y global.

## Reglas

1. **Números concretos en los asserts.** `expect(items[0].cantCompra).toBe(4)` — no `toBeGreaterThan(0)`. Un test que no pinnea un valor no protege una decisión.
2. **Nada de red en tests.** Si un test necesita `ANTHROPIC_API_KEY`, está mal diseñado: usá el mock con fixture.
3. **El golden set es el contrato de precisión (RNF-1):** error global ≤ 2% por rubro contra el esperado. Si tu cambio lo rompe, el cambio está mal o el esperado está mal — decidilo explícitamente y dejalo escrito en el commit, nunca "ajustes" el esperado para que pase sin justificar.
4. Los PDFs de fixtures se generan con `tests/fixtures/make-fixtures.ts` (pdf-lib, determinístico) — no commitees PDFs binarios opacos bajados de internet.
5. Umbral verde: `npm test` sin fallos y `npm run golden` reportando error ≤ 2% en los rubros con golden. Los dos comandos, con salida a la vista, antes de declarar cualquier tarea terminada.
6. **Un fixture del mock puede tapar que algo no funciona en producción, y ya pasó.** El golden 2 ejercitaba la deducción `planilla_plano` a 0,00 % mientras el prompt real le pedía al modelo `entidades: []` para las planillas: el fixture traía las entidades que el modelo nunca devolvía. Cuando escribas un fixture, preguntate si el provider real puede producir **eso**; si el camino solo se ejercita con la API, decilo en el test y verificalo aparte — la suite no lo cubre por más verde que esté.
