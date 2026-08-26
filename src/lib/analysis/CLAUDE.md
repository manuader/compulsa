# CLAUDE.md — src/lib/analysis

Extracción de información de láminas con IA (visión). Acá vive la frontera con el mundo no determinístico — por eso todo pasa por una interfaz.

## La interfaz

```ts
interface AnalysisProvider {
  leerRotulo(lamina: LaminaInput): Promise<RotuloDetectado>;      // título, escala, disciplina, tipo, revisión
  extraerEntidades(lamina: LaminaInput, ctx: ObraContexto): Promise<EntidadDetectada[]>;
}
```

Dos implementaciones, elegidas por `getAnalysisProvider()`:

- **`mock.ts` (default sin `ANTHROPIC_API_KEY`, y SIEMPRE en tests):** determinístico. Busca un fixture JSON en `tests/fixtures/analysis/` con clave `slug(documentoNombre)-p<numeroPagina>` (los bytes del PDF no sirven como clave: pdf-lib re-serializa con fechas y el hash no es estable). Sin fixture → devuelve rótulo vacío con `escalaConfiable: false` (el pipeline bloquea la lámina, que es el comportamiento honesto). El mock permite correr el pipeline completo y la UI sin gastar un token.
- **`claude.ts` (con `ANTHROPIC_API_KEY`):** Claude con visión + structured outputs (tool use con schema Zod). Modelo por defecto `claude-sonnet-5` vía env `ANALYSIS_MODEL`. Antes de tocar este archivo, leé la skill `claude-api` — no escribas llamadas a la API de memoria.

## Reglas

1. **Provenance obligatorio:** toda entidad detectada lleva `bbox` normalizado 0–1 (origen arriba-izquierda de la lámina) y `confianza` 0–1. Sin bbox no hay entidad — el pipeline la descarta y loggea.
2. **El provider no escribe en la DB.** Devuelve datos; el pipeline (`src/lib/pipeline/`) persiste, audita y decide. Mantené esa frontera: hace testeable todo lo demás.
   **La única excepción es `registrarAuditoria()`** (regla 5, RNF-7): los providers reales —`claude.ts`, `presupuesto-claude.ts`, `qa-claude.ts`— escriben su propia fila de `auditoria` con los tokens de la llamada. Tiene que ser ahí: el consumo lo sabe quien hizo la llamada, y hacerlo devolver el `usage` para que lo escriba el pipeline obligaría a que las tres interfaces lo lleven en su tipo de retorno solo para eso. Ninguna otra tabla se toca desde acá.
3. **El provider no inventa (P4).** El prompt de `claude.ts` instruye explícitamente devolver `null`/lista vacía ante ausencia de datos, jamás estimar. Campos no visibles → ausentes. La deducción es un motor de reglas aparte (F2), no un prompt.
4. **Escala (RF-201):** `RotuloDetectado.escalaConfiable` solo es `true` si la escala declarada se verificó contra ≥ 2 cotas leídas del plano (tolerancia 3%). Sin verificación → `false` → la lámina queda `bloqueada_escala` hasta que el usuario cargue una medida de referencia.
5. **Costos (RNF-7):** `claude.ts` registra tokens de entrada/salida por llamada en la tabla `auditoria` (accion `analisis_llm`) para poder medir el costo por obra.
6. Los fixtures del mock son parte del contrato de tests: si cambiás el shape de `EntidadDetectada`, actualizá fixtures + tipos + ambos providers en el mismo commit.
