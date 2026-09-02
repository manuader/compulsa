# CLAUDE.md — src/lib/analysis

Extracción de información de láminas con IA (visión). Acá vive la frontera con el mundo no determinístico — por eso todo pasa por una interfaz.

## La interfaz

```ts
interface AnalysisProvider {
  leerRotulo(lamina: LaminaInput, ctx?: ObraContexto): Promise<RotuloDetectado>;  // título, escala, disciplina, tipo, revisión
  extraerEntidades(lamina: LaminaInput, ctx: ObraContexto): Promise<EntidadDetectada[]>;
  inventariar?(lamina: LaminaInput, ctx?: ObraContexto): Promise<RotuloDetectado>; // fase 1: solo el rótulo, barato
}
```

`inventariar` es la **fase de inventario** del pipeline: una pasada corta y paralela
que lee únicamente rótulos, para que la extracción de cada lámina arranque con el
índice completo del expediente en su `ObraContexto`. Es opcional (quien lo consume
llama a `inventariarLamina()`, que cae a `leerRotulo`) y en `claude.ts` **no comparte
el caché por lámina**: ese caché guarda la extracción completa y el inventario existe
para no pagarla. Su `ctx` **no viaja al prompt** —el índice es lo que esta fase
construye— sino que existe por el costo: sin `ctx.obraId` la fila `inventario_llm`
queda sin obra y el consumo del inventario no se ve en `/estudio/auditoria` (RNF-7).

El `ctx` de `leerRotulo` es **opcional y aditivo** (el mock lo ignora), y existe por
el caché de `claude.ts`: el provider real resuelve la lámina entera en **una** llamada
y la cachea por `laminaId`, así que manda el prompt de la **primera** llamada. Como el
pipeline pide el rótulo antes que las entidades, sin este parámetro el `ObraContexto`
no llegaba nunca al prompt (y la fila de auditoría quedaba sin `obraId`).

El texto del contexto lo arma `prompt.ts`, que es **puro y sí tiene tests**:
`armarContextoObra(ctx)` (tipo de obra, resumen, índice de láminas, instrucciones del
estudio) y `textoInstrucciones(config.instruccionesExtraccion)`. Regla del módulo: lo
que se pueda equivocar va en `prompt.ts`, no en `claude.ts`.

Dos implementaciones, elegidas por `getAnalysisProvider()`:

- **`mock.ts` (default sin `ANTHROPIC_API_KEY`, y SIEMPRE en tests):** determinístico. Busca un fixture JSON en `tests/fixtures/analysis/` con clave `slug(documentoNombre)-p<numeroPagina>` (los bytes del PDF no sirven como clave: pdf-lib re-serializa con fechas y el hash no es estable). Sin fixture → devuelve rótulo vacío con `escalaConfiable: false` (el pipeline bloquea la lámina, que es el comportamiento honesto). El mock permite correr el pipeline completo y la UI sin gastar un token.
- **`claude.ts` (con `ANTHROPIC_API_KEY`):** Claude con visión + structured outputs (tool use con schema Zod). Modelo por defecto `claude-sonnet-5` vía env `ANALYSIS_MODEL`. Antes de tocar este archivo, leé la skill `claude-api` — no escribas llamadas a la API de memoria.

## Las otras familias de providers

El módulo tiene **cinco** familias, cada una con su trío `*-tipos / *-mock / *-claude` y su propio `get*Provider()`. `index.ts` exporta **solo** la de láminas: las demás se importan por ruta (`@/lib/analysis/busqueda-tipos`), igual que `verificacion.ts` importa `claude.ts` directo.

| Familia | Archivos | Qué hace |
|---|---|---|
| láminas | `tipos/mock/claude` | rótulo y entidades (arriba) |
| presupuestos | `presupuesto-*` | lee el presupuesto que mandó el proveedor |
| Q&A | `qa-*` | «Preguntale al expediente» (RF-106) |
| **búsqueda dirigida** | `busqueda-*` | relee una lámina **con la lista de lo que falta en la mano** |
| **cruce** | `cruce-*` | mira el expediente **entero** y lo relaciona consigo mismo |

**Búsqueda dirigida** (`buscarDatos(lamina, objetivos, ctx)`): recibe los campos que una consulta abierta necesita y devuelve `DatoEncontrado[]` con bbox y confianza. Tres cosas que no son evidentes:

- **Solo propone. Jamás escribe `atributos_json`** (regla 3, P4): el pipeline deja el resultado en `hallazgos.valor_propuesto_json` y el dato entra a la entidad **únicamente cuando el arquitecto confirma**.
- **`valor` viaja por el cable como `string`** — evita un `anyOf` en la gramática de structured outputs, y una planilla argentina escribe `0,90`: que el modelo transcriba lo escrito y la conversión con coma decimal la haga nuestro código es más honesto que pedírsela a él.
- **El mock sin fixture devuelve `[]`, no una heurística.** A diferencia de los mocks de presupuesto y Q&A, acá no hay caída a un match por palabras sobre `textoExtraido`: ese match no sabe cuál de los números de la fila es el ancho ni dónde está su bbox, y adivinarlo sería una propuesta con provenance inventada. Fixtures en `tests/fixtures/analysis/busqueda/`, con la **misma** clave que el mock de láminas (`slug(documentoNombre)-p<página>`), un nivel más abajo. El fixture pasa por `sanearBusqueda`, así que no puede colar una clave ni un campo que la corrida no pidió.

**Cruce** (`cruzar(memoria, ctx)`): la única familia que **no** mira una lámina. Recibe la memoria compactada de toda la obra (`src/lib/memoria/compacta.ts`) y devuelve cinco listas —datos de obra, campos completados, identidades, conflictos y relecturas pedidas—. Cuatro cosas que no son evidentes:

- **Cita las láminas por código de rótulo, no por uuid**, porque es lo que el modelo lee. `sanearCruce(crudo, ctx)` los resuelve contra el expediente real (exacto primero, `normalizarTag` después) y descarta —contando por categoría— lo que no resuelve.
- **`cruzar()` devuelve el CRUDO, no el saneado** — al revés que las otras cuatro. El saneo necesita el mapa de códigos y las entidades de la obra, que son cosas de la base: el provider no tiene por qué saber de dónde salen. Un solo saneo, río abajo, el mismo para el mock que para el modelo.
- **`completados` pasa por `esCampoDeducible()`** (RF-506): un campo fuera de `CAMPOS_DEDUCIBLES` se descarta aunque el modelo lo haya leído bien. El cruce no es una excepción a "nada estructural ni de seguridad se auto-propone".
- **Sin bbox usable la fuente es la lámina completa**, no un descarte —la diferencia deliberada con la búsqueda dirigida—: el modelo cruza sobre un texto compactado que ya no tiene los PDFs delante, y exigirle coordenadas sería pedirle que las invente. Fixtures en `tests/fixtures/analysis/cruce/<slug(nombreObra)>.json`; sin fixture, las cinco listas vacías.

`sanearBusqueda` es el equivalente de `sanearAnalisis` para esta familia: descarta —y cuenta— lo que no se pidió, los bbox que no son 4 números finitos y los valores no numéricos en campos de medida. Es la disciplina **del provider**; la del pipeline sobre la base es `zValorPropuesto`, que se aplica aparte (`deps.provider` es inyectable y `DatoEncontrado` es solo una interfaz de TypeScript).

## Reglas

1. **Provenance obligatorio:** toda entidad detectada lleva `bbox` normalizado 0–1 (origen arriba-izquierda de la lámina) y `confianza` 0–1. Sin bbox no hay entidad — el pipeline la descarta y loggea.
2. **El provider no escribe en la DB.** Devuelve datos; el pipeline (`src/lib/pipeline/`) persiste, audita y decide. Mantené esa frontera: hace testeable todo lo demás.
   **La única excepción es `registrarAuditoria()`** (regla 5, RNF-7): los providers reales —`claude.ts`, `presupuesto-claude.ts`, `qa-claude.ts`— escriben su propia fila de `auditoria` con los tokens de la llamada. Tiene que ser ahí: el consumo lo sabe quien hizo la llamada, y hacerlo devolver el `usage` para que lo escriba el pipeline obligaría a que las tres interfaces lo lleven en su tipo de retorno solo para eso. Ninguna otra tabla se toca desde acá.
3. **El provider no inventa (P4).** El prompt de `claude.ts` instruye explícitamente devolver `null`/lista vacía ante ausencia de datos, jamás estimar. Campos no visibles → ausentes. La deducción es un motor de reglas aparte (F2), no un prompt.
   **Pero no confundas "no inventar" con "no leer":** una **planilla de carpinterías** es una tabla de datos escritos y se extrae **una entidad `abertura` por fila** (con `bbox` = la fila), porque ahí es donde el estudio escribe las medidas que la planta no trae — saltearla dejaba a la deducción planilla↔plano sin nada que cruzar. `cantidad` de la planilla es informativa y no computa: la cantidad la pone la planta. Carátulas, memorias e índices siguen con `entidades: []`.
4. **Escala (RF-201):** `RotuloDetectado.escalaConfiable` solo es `true` si la escala declarada se verificó contra ≥ 2 cotas leídas del plano (tolerancia 3%). Sin verificación → `false`, y **el provider sigue diciendo lo mismo que siempre** — lo que cambió es qué hace el pipeline con eso: si el rótulo **declara** una escala, la lámina se analiza y se computa asumiéndola, con un supuesto no bloqueante que el arquitecto confirma con un click; una lámina **sin escala declarada** queda `bloqueada_escala`, **salvo que sea una planilla**, que se analiza igual y sin abrir consulta de escala (en una tabla no se mide, se transcribe). La decisión vive en `pipeline/procesar.ts` (`analizarLamina` + `modoEscala`), no acá.
   Del lado del prompt, el corolario es que **`escalaConfiable: false` es la respuesta normal y esperada**, y que lo que sí importa es devolver en `escala` lo que el rótulo declare —`null` si no declara ninguna—: es lo que se le propone al arquitecto para confirmar. La regla 4 de `SISTEMA` decía "la lámina queda bloqueada hasta que el usuario cargue una medida de referencia, y eso está bien", que dejó de ser cierto con la decisión 1 y empujaba al modelo en la dirección equivocada.
5. **Costos (RNF-7):** los providers reales registran tokens de entrada/salida por llamada en `auditoria` para poder medir el costo por obra: `analisis_llm` (`claude.ts`), `busqueda_llm` (`busqueda-claude.ts`) y `cruce_llm` (`cruce-claude.ts`, una llamada por obra y la más grande del pipeline). La búsqueda dirigida **es plata del usuario**: corre con un cap de 8 láminas por corrida, corta apenas no queda ningún campo pendiente, y no vuelve a buscar lo que ya buscó (marca en `hallazgos.busqueda_json` que caduca por huella de la documentación, no por reloj).
6. Los fixtures del mock son parte del contrato de tests: si cambiás el shape de `EntidadDetectada`, actualizá fixtures + tipos + ambos providers en el mismo commit.
