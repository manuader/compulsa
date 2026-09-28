# Diseño — Jev en el análisis del expediente y en el cómputo

> **Fecha:** 2026-09-21 · **Estado:** diseño, nada implementado · **Precede a:** cualquier línea de código, y a la prueba de idioma del §10.
> Lee antes: [`docs/EVAL-2026-09-21-jev.md`](../../EVAL-2026-09-21-jev.md) (qué es Jev y qué no puede hacer) y `src/lib/analysis/CLAUDE.md`.

## 1. Una corrección a la evaluación de ayer, y es la que abre todo

La evaluación cerró con «Jev no puede extraer: no ve PDFs y no transcribe valores». Lo primero sigue siendo cierto. **Lo segundo estaba mal planteado**, y el cookbook de *pre-parsed value extraction* de TypeSafe es la corrección: Jev no transcribe, pero **elige entre candidatos que el código ya encontró**, y el código copia el candidato elegido tal cual. Si los candidatos vienen con su posición, el valor sale con su `bbox` sin que ningún modelo lo haya inventado.

Y los candidatos con posición ya están en el PDF. `pdfjs.getTextContent()` devuelve, por cada fragmento de texto de la lámina, un `TextItem` con `str`, `transform` (la matriz que da x/y), `width` y `height` — verificado contra los tipos publicados de `pdfjs-dist@4.10.38`. **`src/lib/pdf/texto.ts` hoy los recorre y tira todo menos `str`.**

Eso cambia la ecuación de este proyecto entero:

| | Hoy | Con la capa de spans |
|---|---|---|
| Quién encuentra el valor | Claude, mirando el dibujo | el parser de PDF (determinístico) |
| Quién lo transcribe | Claude («0,90») | **nadie**: el código copia el span |
| De dónde sale el `bbox` | del modelo, y `sanearAnalisis` lo clampa y descarta los que no son 4 números | del parser, exacto |
| Qué puede salir mal | una transposición de dígitos invisible para la planilla | que se elija el span equivocado — **auditable, porque el span está resaltado en la lámina** |

P1 (provenance) y P4 (deducir, no inventar) dejan de ser una disciplina que el prompt pide y pasan a ser una propiedad estructural: **un valor que salió de un span no puede ser un valor que no está escrito en la lámina.**

Esto no reemplaza la visión. Reemplaza **la parte del trabajo de la visión que es leer texto que ya está en el archivo**, que en un expediente de CAD es casi toda la planilla de carpinterías, todo el rótulo, todas las cotas y todos los nombres de ambiente. Queda para Claude lo que solo se ve mirando: qué es un tabique y dónde empieza, qué está rayado como a demoler, qué líneas forman un local.

---

## 2. La pieza habilitadora: `SpanTexto` (código puro, sin IA)

Antes de cualquier llamada a Jev hay que construir esto. Es útil por sí solo y no depende de que Jev se adopte.

```ts
// src/lib/pdf/texto.ts
/** Un fragmento de texto del PDF, con dónde está en la hoja. */
export interface SpanTexto {
  /** Id estable dentro de la lámina: `s12`. Es lo que Jev elige. */
  id: string;
  texto: string;
  /** Normalizado 0–1, origen arriba-izquierda: el mismo `BBox` del dominio. */
  bbox: BBox;
}

export async function extraerSpans(
  pdfBytes: Uint8Array,
): Promise<{ texto: string; spans: SpanTexto[] }>;
```

Tres cosas que este módulo tiene que sostener:

1. **`extraerTexto()` no cambia de firma.** Sigue devolviendo el string de siempre y pasa a ser un `.map(s => s.texto).join()` sobre la salida nueva. Nada río abajo se entera.
2. **La conversión de coordenadas es la única cuenta, y va con test.** pdfjs da el origen abajo-izquierda y en puntos; el dominio quiere 0–1 arriba-izquierda. Con `TamanoPagina` —que `separarPaginasConTamano` **ya calcula, con la rotación aplicada**— la cuenta es `x = e/W`, `y = 1 − (f + alto)/H`, `ancho = width/W`, `alto = height/H`. Se pinnea con un PDF de fixture y cuatro spans en las cuatro esquinas.
3. **Los spans se persisten por lámina** (`laminas.spans_json`, o tabla aparte si pesan). Se calculan una vez, al separar el PDF, junto con `texto_extraido`. Un span es un derivado, no toca el original (regla 6).

**Una lámina escaneada no tiene spans.** Eso no es un error: es la señal de que esa lámina va por visión, y el pipeline la rutea sola. `spans.length === 0` es la condición.

---

## 3. Los buscadores de candidatos (código puro, sin IA)

Segundo módulo sin IA: `src/lib/pdf/candidatos.ts`. Regexes **calibradas para sobre-encontrar** — la disciplina del cookbook: es barato que sobre un candidato y es fatal que falte, porque Jev no puede elegir lo que no está en la lista.

| Buscador | Qué matchea | Para qué campo |
|---|---|---|
| `medidas` | `1,20` · `0.90` · `2.60 m` · `120` · `90 cm` | `anchoM`, `altoM`, `alturaM`, `superficieM2` |
| `tags` | `V2` · `FP 01` · `P-3` · `D4` | `tag` de carpintería |
| `escalas` | `1:50` · `1 : 100` · `ESC 1:20` | `escala` del rótulo |
| `niveles` | `PB` · `N.+2.80` · `1º PISO` | `nivel` |
| `ambientes` | vocabulario cerrado: dormitorio, baño, cocina, estar, comedor, lavadero, pasillo, hall… | `nombre` de ambiente |
| `materiales` | vocabulario del gremio: durlock, placa de yeso, roca de yeso, mampostería, ladrillo hueco, DVH, float, laminado, aluminio, PVC… | `material`, `tipo`, `vidrio` |

Salida: `CandidatoSpan { spanId, texto, tipo }`. Dos reglas: dedupe por `(texto, bbox)` y **orden de lectura** (arriba-abajo, izquierda-derecha), porque en una planilla la fila es el contexto y el orden es lo que la reconstruye.

El vocabulario del gremio vive **como dato, en un módulo hoja con tests**, igual que `ALTERNATIVAS_POR_SPEC` en la conciliación. No en el prompt.

---

## 4. Las seis intervenciones

Orden por (impacto × facilidad). Cada una dice qué estado recibe Jev, qué pregunta, qué umbral y a dónde cae si no llega.

### I1 · Rótulo por selección de span (fase **inventario**)

**Hoy:** 25 llamadas de visión, una por lámina, solo para leer el rótulo (`procesar.ts:948`, cap 4). Es la fase más tonta del pipeline y se come el presupuesto de los 300 s.

**Estado (uno por lámina):**
```json
{
  "spans_de_la_lamina": [{"id": "s3", "texto": "PLANTA BAJA"}, {"id": "s7", "texto": "ESC 1:50"}, ...],
  "candidatos_escala": ["s7", "s41"]
}
```
**Preguntas (una sola request, fan-out):**
- `tipo_lamina` → **Choice** sobre `TIPOS_LAMINA`, con `criteria` que describan cada tipo en términos de obra.
- `disciplina` → **Choice** sobre `DISCIPLINAS`.
- `escala` → **Choice sobre `candidatos_escala` + `ninguno`**. No es una lista inventada de escalas posibles: es *cuál de los textos que dicen «1:algo» en esta lámina es la escala del rótulo*. El código parsea el span elegido.
- `es_planilla_de_carpinterias` → **Noul**. Es la que decide si la lámina entra por I2.

**Umbral:** los tres primeros a ≥ 0,99 se usan; por debajo, o con `spans` vacío, **cae a `inventariar()` de Claude, exactamente como hoy**. `codigo` y `titulo` no se preguntan: son strings libres y siguen por visión.

**Esfuerzo:** M. **Métrica:** segundos de la fase de inventario, y coincidencia contra el rótulo que devuelve Claude sobre el mismo set.

---

### I2 · Planilla de carpinterías fila por fila, sin visión

**Hoy:** la planilla se extrae con visión, «una entidad `abertura` por fila, con `bbox` = la fila» (regla 3 del módulo). Es una tabla de texto vectorial: el dato está literalmente en el archivo y lo estamos pagando como si fuera un dibujo.

**Estado (uno por lámina):** los spans agrupados en filas por el código (mismo `y` ± tolerancia), más la fila de encabezados si la hay.
```json
{
  "filas": [
    {"id": "f4", "celdas": [{"id":"s31","texto":"FP01"},{"id":"s32","texto":"0,90"},{"id":"s33","texto":"2,05"},{"id":"s34","texto":"ALUMINIO"}]},
    ...
  ]
}
```
**Preguntas (una por fila, todas en la misma request):**
- `f4_ancho` → Choice sobre las celdas de la fila + `ninguno`. «¿Cuál celda de `filas[3].celdas` es el **ancho** de la abertura?»
- `f4_alto`, `f4_tag`, `f4_material`, `f4_tipologia` (esta última Choice sobre `ventana | puerta | paño fijo`).

**Por qué Jev y no una regla de columnas:** porque cada estudio arma la planilla distinta, con encabezados que dicen «ANCHO», «A», «L», «MEDIDAS» o nada, y las columnas se corren. Es exactamente «interpretar datos desordenados». Y porque la alternativa no es una regla: es visión, que cuesta cien veces más y transcribe.

**Umbral:** ≥ 0,99 ⇒ la entidad se crea con `origen: 'explicito'` y `bbox` = la celda elegida. Cualquier campo por debajo ⇒ ese campo queda vacío y la lámina entra a la cola de visión con **solo los campos que faltan**, no entera.

**La trampa a no pisar:** `cantidad` de la planilla sigue siendo informativa y **no computa** — la cantidad la pone la planta. Eso ya está decidido y no lo cambia el mecanismo.

**Esfuerzo:** M/L (el agrupado en filas es el trabajo). **Métrica:** el golden set, rubro aberturas, con el provider de visión apagado para las planillas.

---

### I3 · Búsqueda dirigida sobre toda la obra — el fin del cap de 8

**Hoy:** `laminasCandidatas` (`busqueda.ts:437`) ordena planillas → citadas, corta en 8 llamadas de visión, y el propio comentario admite que «las láminas del final del orden no se leen nunca».

**Con spans no hace falta elegir 8 láminas: se miran las 25.** El estado ya no es un PDF, son strings.

**Estado (por lote de láminas, ver el presupuesto de tokens abajo):**
```json
{
  "buscando": "el ancho de la abertura FP01",
  "spans": [{"id":"L3.s31","texto":"FP01","lamina":"PL02"}, ...]
}
```
**Preguntas:** un **Choice** por objetivo pendiente sobre los spans candidatos del tipo correcto (medidas para un `anchoM`), más `ninguno`. Varios objetivos en la misma request.

**Umbral y qué pasa con baja confianza —y acá está el matiz que no se puede saltear:**
- ≥ 0,99 ⇒ **propuesta** en `hallazgos.valor_propuesto_json`, con `origen: 'busqueda_dirigida'` y el `bbox` del span. **Sigue sin escribir `atributos_json`**: el arquitecto confirma con un click. La decisión 1 del módulo no se toca.
- Por debajo ⇒ la lámina con mayor probabilidad entra a la cola de **visión**, que es lo de hoy, pero ahora **ordenada por evidencia y no por tipo de lámina**.
- `ninguno` con confianza alta en todas las láminas ⇒ recién ahí se marca `busqueda_json` («buscado y no está»), y **solo si se miraron todas** — la regla actual de no marcar sobre una corrida truncada se vuelve fácil de cumplir porque ya no hay truncado.

**Presupuesto de tokens, que acá es una restricción real:** el `state` tiene tope de **32k tokens**. Una lámina densa puede tener entre 500 y 2000 spans; a ~5 tokens por span eso es 2,5k–10k por lámina. Regla: **lotes de hasta 4 láminas por request**, y los spans se filtran por tipo de candidato antes de armar el estado (para buscar un ancho no entran los nombres de ambiente). Una obra de 25 láminas son ~6 requests de Jev — contra 8 de visión hoy, y mirando la obra entera.

**Esfuerzo:** M. **Métrica:** consultas de bandeja que resultaron contestables por la documentación (el pecado original de la ola de «proponer en vez de bloquear»), y llamadas de visión por corrida.

---

### I4 · Verificación campo por campo (cascada de extracción)

**Hoy:** RF-306 es una **segunda pasada de visión completa**: 25 llamadas más, corridas a pedido, para computar en paralelo y contar diferencias > 5 %. Cara, lenta, y por eso no corre siempre.

**El patrón es el `sde_cascade` de TypeSafe, con nuestros rungs:** Claude extrae (rung 0) → **Jev verifica campo por campo** → solo lo que dispara escala a una segunda lectura de visión (rung 1).

**Estado (uno por lámina):** los spans de la lámina + las entidades que Claude extrajo de ella.
```json
{
  "spans": [...],
  "entidades": [{"i": 0, "nombre": "FP01", "anchoM": 0.90, "altoM": 2.05}, ...]
}
```
**Preguntas (una por campo numérico extraído, fan-out; PriorBench midió 800 juicios en una request, 985 ms):**
- `e0_ancho_ausente` → **Noul**: «el valor `0.90` de `entidades[0].anchoM` **no** aparece en ninguno de los `spans`». Devuelve P(el valor está inventado o transpuesto).
- `e0_ancho_de_otra_cosa` → **Noul**: «el span que contiene `0.90` describe algo distinto de `entidades[0]`».

**Umbral:** cualquiera de las dos > 0,70 ⇒ **el campo** —no la lámina— entra a la segunda lectura de visión. La consulta que se abre es la misma `inconsistencia` no bloqueante de hoy, con la misma clave `verificacion.<claveItem>`.

**Lo que esto cambia de verdad:** la doble pasada deja de ser una función que alguien dispara y pasa a **correr siempre, en toda obra**, porque cuesta centésimas de centavo. Un `2,50` leído donde decía `2,60` es el error más caro y más invisible de este producto, y es exactamente lo que un verificador textual atrapa.

**Cuidado con lo que este verificador NO cubre:** un valor que Claude midió sobre el dibujo (`medicion.ts`, origen `inferido`) **no está escrito en ningún span**, así que dispararía siempre. Los campos con origen `inferido` quedan fuera de la verificación textual, por construcción y con un test que lo pinnee.

**Esfuerzo:** M. **Métrica:** diferencias encontradas por obra contra las que encuentra la doble pasada de visión sobre el mismo set — este es el experimento más limpio de todos, porque hay baseline exacto.

---

### I5 · Material y tipología: la decisión que define el rubro

**Hoy:** si la entidad no trae `tipo`/`material`, se abre una consulta. Pero el dato suele estar escrito en las **referencias** de la lámina: «TABIQUE DE ROCA DE YESO 12,5 DOBLE PLACA S/ESTRUCTURA 70mm». Nadie lo mira, porque el extractor va entidad por entidad y las referencias son un bloque de texto suelto.

Y no es un detalle: **`durlock` contra `mampostería` cambia el rubro entero** (seco contra gruesa). Un regex no lo resuelve — durlock, placa de yeso, roca de yeso y Knauf son la misma cosa y no se parecen como strings. Eso es sentido común de gremio, que es literalmente lo que Jev aporta.

**Estado:** los spans de referencias/leyenda de la lámina + la entidad.
**Pregunta:** `material` → **Choice** sobre el vocabulario canónico del dominio (`durlock | mamposteria_ladrillo | hormigon | otro | no_dice`), con `criteria` que enumeren los sinónimos del gremio argentino en cada opción.
**Umbral:** ≥ 0,99 ⇒ **propuesta** con el span de la referencia como fuente, para confirmar de un click. Por debajo ⇒ la consulta de hoy.

**Regla que no se negocia:** esto propone, no escribe, y **no entra en la auto-validación del §3.2** aunque supere el umbral. Cambiar el rubro de un ítem es demasiado consecuente para aplicarlo sin un click, y el precedente correcto es RF-506: lo consecuente se pregunta.

**Esfuerzo:** S/M. **Métrica:** consultas de material por obra.

---

### I6 · Sanity semántico del cómputo (lo que hoy no mira nadie)

**Hoy:** `computo/sanity.ts` tiene **un** chequeo, y es aritmético (piso contra cielorraso, ±10 %). Nada mira si la planilla *tiene sentido*.

**Estado (uno por obra):** la lista de ítems computados, en texto.
**Preguntas (una por ítem, fan-out, una sola request por obra):**
- `i12_coherente` → **Noul**: «un ítem de `revestimiento cerámico` en un ambiente llamado `Dormitorio 1` es esperable en una obra de este tipo».
- `i12_nombre_vs_tipo` → **Noul**: «el nombre `V2` es coherente con el tipo `tabique`».

**Umbral:** por debajo de 0,30 de coherencia ⇒ **consulta `inconsistencia` no bloqueante**, con el mismo tratamiento que los sanity de hoy. Nunca borra un ítem, nunca cambia un número.

**Por qué es nuevo:** hoy un error de extracción que no rompe ninguna aritmética —un cielorraso asignado al ambiente equivocado, una abertura con el tag de otra— llega a la planilla y lo descubre el arquitecto, o el corralón. Correr un LLM sobre cada ítem de cada obra era impensable; con una request por obra es gratis.

**Nada de esto es numérico y está a propósito.** Jev no compara magnitudes: los ±5 %, ±10 % y ±3 % siguen en código, donde están.

**Esfuerzo:** S. **Métrica:** cuántas de estas consultas el arquitecto marca como acertadas (hace falta un botón «esto estaba mal» en la bandeja, que además sirve para todo lo demás).

---

## 5. Cómo queda el pipeline, fase por fase

```
ANTES                                        DESPUÉS
─────────────────────────────────────────────────────────────────────────────
split PDF                                    split PDF
  └ texto_extraido (string)                    └ texto_extraido + spans[]  ← I0, sin IA

1. inventario                                1. inventario
   25 × visión (rótulo)                         1 × Jev por lámina (rótulo)   ← I1
                                                + visión SOLO si no llegó al umbral

2. extracción                                2. extracción
   25 × visión (entidades)                      planillas → Jev sobre filas    ← I2
                                                el resto → visión, igual que hoy
                                                + Jev verifica campo por campo ← I4
                                                  y escala a visión lo que dispara

3. cruce                                     3. cruce  (sin cambios: sigue Claude)
   1 × Claude sobre memoria compacta            + identidades por Jev (opcional, §5.5 de la eval)

4. relectura                                 4. relectura
   ≤ 8 × visión, cap duro                       1 Jev por lote de 4 láminas,   ← I3
   las del final nunca se leen                  la obra ENTERA, sin cap

5. listo                                     5. listo
   recompute + resumen                          + material/tipología           ← I5
                                                + sanity semántico             ← I6
```

Lo que no se mueve: las cinco fases, la tolerancia de cada una (una fase que falla queda anotada y la corrida sigue), la idempotencia, y que `obras.analisis_json` lleve la fase en curso con su `desde`.

---

## 6. La frontera: `src/lib/decision/`

Sexta familia de providers, con exactamente la disciplina de las otras cinco (`src/lib/analysis/CLAUDE.md`).

```ts
// src/lib/decision/tipos.ts
export interface DecisionProvider {
  /** Una request: un estado, N preguntas tipadas, N respuestas con probabilidad. */
  decidir<Q extends Preguntas>(estado: Estado, preguntas: Q): Promise<Respuestas<Q>>;
}
export function getDecisionProvider(): DecisionProvider;
```

- **`mock.ts`** — default sin `TYPESAFE_API_KEY` y **SIEMPRE en tests**. Fixtures en `tests/fixtures/decision/`, con la misma clave que el resto (`slug(documentoNombre)-p<página>`). Sin fixture: devuelve la respuesta que deja todo como está hoy (confianza 0), no una heurística. La regla del módulo de búsqueda vale igual acá: adivinar sería una propuesta con provenance inventada.
- **`jev.ts`** — `@typesafe-ai/sdk` (Node ≥ 20; el proyecto corre en 21), modelo **pinneado en `jev-1.13.0`**, nunca el alias: los umbrales se tunean contra una versión.
- **`claude.ts`** — fallback con structured outputs, para poder medir «¿Jev o cualquier modelo?» y para el día que la API de TypeSafe no esté.

Reglas heredadas, sin excepción:
1. **El provider no escribe en la base.** Devuelve decisiones; el pipeline persiste, audita y decide.
2. **Menos `registrarAuditoria()`**, que sí va acá: fila `decision_llm` con tokens de entrada, modelo que contestó (la respuesta trae el id versionado) y la clave de la pregunta. RNF-7 no tiene excepciones, y `/estudio/auditoria` tiene que poder decir cuánto costó cada fase.
3. **Una salida que no parsea se audita y se levanta, nunca se devuelve vacía.** El anti-patrón `?? []` ya se pagó dos veces en este repo.
4. **Los `criteria` viven en un módulo puro con tests**, como `analysis/prompt.ts`. Es la regla que más importa acá: con criterios mal escritos la precisión de Jev cae a 16,7 %, **peor que el azar**. Un criterio es código, no una constante suelta.

---

## 7. Umbrales, en un solo lugar

| Decisión | Umbral | Si no llega |
|---|---|---|
| Rótulo (tipo, disciplina, escala) | **0,99** | visión, como hoy |
| Celda de planilla → campo | **0,99** | el campo queda vacío; visión solo para ese campo |
| Búsqueda dirigida → propuesta | **0,99** | la lámina entra a la cola de visión, ordenada por probabilidad |
| Verificador de campo (dispara) | **`noul` > 0,70** de que está mal | no escala |
| Material / tipología | **0,99** | consulta, como hoy |
| Sanity semántico | **< 0,30** de coherencia | no abre nada |

**Dos correcciones que salieron de medir (§11), no de leer un blog:**

1. **Un Noul no tiene `confidence`.** La API devuelve solo `noul`, la probabilidad de que sí. Medido acá, los Nouls de verificación se estacionan en 0,96/0,04 y los de sustitución en 0,93/0,07: **ninguno llega nunca a 0,99**, así que un umbral de 0,99 sobre un Noul rechaza el 100 % de los casos. El umbral de un Noul se escribe sobre la probabilidad cruda (`noul > 0,90` o `< 0,10`), no sobre una «confianza» derivada.
2. **El 0,99 probablemente sea demasiado conservador para este dominio.** PriorBench midió que la precisión de Jev es plana entre 0,50 y 0,95 y salta a 100 % en 0,99. Sobre nuestros datos **no pasó eso**: la precisión fue del 100 % hasta 0,70 y el único error apareció por debajo, con confianza 0,37. Con el gate en 0,99 se automatiza el 56 % de las decisiones; con el gate en 0,90, el 87 %, y en esta muestra sin un solo error de más. **No se baja el umbral con n=82 y un dataset propio**, pero queda anotado como la primera cosa a re-medir cuando haya obras reales.

Y **el 0,70 del §3.2 del diseño —el de auto-validar deducciones— no se reusa acá**: es otro modelo, otra escala y otra cosa.

Los seis números se pinnean en `contratos-y-formulas.md` y se re-miden sobre datos propios antes de encender nada.

---

## 8. Qué no cambia

1. **Nada sin fuente entra al cómputo** (P1). Con spans es más fuerte que antes, no más débil.
2. **La IA jamás pone un precio.**
3. **`CAMPOS_DEDUCIBLES` / RF-506.** Nada estructural ni de seguridad se auto-propone, venga de donde venga.
4. **La auto-validación del §3.2 no se extiende.** Lo que Jev propone entra por la bandeja o por el umbral que ya existe; no se inventa una puerta nueva.
5. **El motor de deducción del §11 no se toca.** Sus cinco reglas son determinísticas, con ≥ 2 fuentes y una confianza que es una fórmula que se le muestra al arquitecto.
6. **Toda la aritmética sigue en código.** Jev no cuenta, no compara fechas y no interpola magnitudes: está documentado por el fabricante y confirmado por terceros.
7. **Los originales no se tocan.** Los spans son un derivado más.

---

## 9. Tests

Test-first donde corresponde (regla 5 del repo: el dominio puro se desarrolla test-first).

| Qué | Dónde | Qué pinnea |
|---|---|---|
| conversión de coordenadas | `tests/unit/pdf-spans.test.ts` | cuatro spans en las cuatro esquinas de un PDF de fixture, con rotación 0 y 90 |
| buscadores de candidatos | `tests/unit/candidatos.test.ts` | que sobre-encuentren: `0,90` · `.90` · `90 cm` · `0.90m` todos salen |
| agrupado en filas | `tests/unit/planilla-filas.test.ts` | una planilla real, con una fila corrida |
| criterios | `tests/unit/decision-criterios.test.ts` | que cada `Choice` tenga opción de escape (`ninguno`/`no_dice`) y que ninguna supere las 255 opciones |
| mock sin fixture | `tests/unit/decision-mock.test.ts` | devuelve confianza 0 y **no** una heurística |
| umbrales | `tests/unit/decision-umbrales.test.ts` | los seis números, contra `contratos-y-formulas.md` |
| el pipeline entero | `npm run golden` | **el guardián**: los tres casos siguen en 0,00 % con las intervenciones encendidas |
| costos | `tests/unit/auditoria-frases.test.ts` | la acción `decision_llm` tiene frase en es-AR (diecisiete acciones ya se quedaron sin frase una vez) |

**El golden set es el criterio de aceptación de todo esto.** Ninguna intervención entra si mueve un número del golden, y I2 en particular se prueba con el provider de visión **apagado** para planillas: si el rubro aberturas sigue en 0,00 % sin visión, la extracción por spans funciona.

---

## 10. Orden, y qué falta antes de la primera línea

**Orden de implementación:**

| # | Qué | Esfuerzo | Depende de |
|---|---|---|---|
| 0 | **La prueba de idioma** (§8 de la evaluación) | 20 min | acceso a la API |
| 1 | `SpanTexto` + persistencia + coordenadas | **M** | nada. **Se puede hacer hoy, sin Jev y sin API key** |
| 2 | Buscadores de candidatos + vocabulario del gremio | **S/M** | 1 |
| 3 | `DecisionProvider` + mock + fixtures | **M** | nada |
| 4 | I4 verificación campo por campo | **M** | 1, 3 — y es el que tiene **baseline exacto** para medirse |
| 5 | I1 rótulo | M | 1, 3 |
| 6 | I3 búsqueda dirigida | M | 1, 2, 3 |
| 7 | I2 planilla de carpinterías | M/L | 1, 2, 3 |
| 8 | I5 material · I6 sanity semántico | S | 3 |

**Empezaría por 1 y 2, que no dependen de Jev en absoluto.** Los spans con posición mejoran la provenance del sistema tal como está hoy, hacen posible resaltar en la lámina el texto exacto del que salió cada número, y son el sustrato de todo lo demás. Si Jev no se adopta, se quedan igual.

**El primer experimento con Jev es I4**, no I1: es el único que tiene un baseline exacto contra el cual medir (la doble pasada de visión, que ya existe y ya corre), no escribe nada en el cómputo, y contesta la pregunta que importa —*¿entiende castellano de obra?*— sobre datos reales en vez de sobre un probe sintético.

**Lo que falta antes de escribir código:**

1. **Acceso a la API.** Jev está en early access con waitlist: no hay `TYPESAFE_API_KEY` en este repo ni forma de conseguirla escribiendo código.
2. **La prueba de idioma.** Si el castellano rioplatense de obra no le funciona, de las seis intervenciones sobreviven cero.
3. **`npm install`.** No hay `node_modules` en este árbol, así que hoy no se puede correr `npm test` ni `npm run build` — y la regla 5 del repo dice que nada se declara terminado sin las dos verdes, con la salida a la vista.


---

## 11. La prueba de idioma: hecha, y pasó

**2026-09-21.** 82 ítems de castellano rioplatense de obra, etiquetados a mano, cada uno preguntado dos veces: con los criterios en castellano y con los mismos criterios en inglés, siempre con el estado en castellano. 164 requests contra `jev-1.13.0`.

- Dataset: `tests/probes/jev-idioma.json` — **las etiquetas son mías y son revisables.** Los casos donde dos arquitectos podrían discutir la respuesta van marcados `dificil: true` y el reporte los cuenta aparte.
- Runner: `node --env-file=.env.local scripts/probe-jev.mjs`. Sin `node_modules`: `fetch` es global.
- Crudo de la corrida: `tests/probes/jev-idioma-resultados.json`.

| Categoría | Interven. | n | criterios en **es** | criterios en **en** |
|---|---|---|---|---|
| material (durlock / mampostería / H°A°) | I5 | 12 | 100 % | 100 % |
| tipo de lámina | I1 | 10 | 100 % | 100 % |
| tipología de abertura | I2 | 10 | 100 % | 100 % |
| **selección de celda (find + pick)** | I2 | 8 | **100 %** | **100 %** |
| **verificación de campo** | I4 | 10 | **100 %** | **100 %** |
| conciliación línea ↔ ítem | eval §5.2 | 10 | 100 % | 90 % |
| sustitución / contradicción de spec | RF-1002 | 10 | 100 % | 100 % |
| intención del mensaje del proveedor | eval §5.1 | 12 | 100 % | 100 % |
| **TOTAL** | | **82** | **100 %** | **98,8 %** |

**Lo que contesta esto.** El riesgo de idioma era el que podía matar las seis intervenciones, y no las mata. Reconoció *durlock*, *roca de yeso*, *panel de yeso* y *Knauf* como el mismo material; separó *puerta ventana* de *ventana*; entendió *banderola*, *antepecho*, *PGU*, *paño fijo*, *solera*, *montante* y *DVH 4/9/4*; y leyó bien mensajes de WhatsApp con *che*, *dale* y *me fijo y te paso*. **Los criterios en castellano anduvieron igual o mejor que en inglés**, así que la mitigación que este diseño proponía —escribir las preguntas en inglés— **no hace falta**: se escriben en castellano, que además es lo que pide la regla 1 del repo.

**Lo que NO contesta, y conviene tener escrito:**

1. **El dataset es mío.** Lo armé yo, con el vocabulario que yo esperaba. Un 100 % sobre las preguntas de uno mismo mide que el modelo entiende el dominio, no que el sistema va a andar. PriorBench, con un benchmark de 400 ítems que no era suyo, midió 95,9 %.
2. **Los textos son limpios.** Una fila de planilla acá son cinco celdas prolijas; en un PDF real vienen partidas, con la unidad en otra celda y una columna corrida. Eso lo prueba I2 contra el golden set, no este probe.
3. **Nada de esto probó visión, porque Jev no ve.** Todo lo que este probe valida es la capa de texto.
4. **El único error fue `conc-10`** (`Perfil PGU 70` → es la solera, no el montante), con criterios en inglés y **confianza 0,37**. El gate lo hubiera atajado. Es el caso que mejor muestra para qué existe el umbral.

**Costo y latencia, medidos desde Buenos Aires** (los 70–500 ms del fabricante son desde la costa oeste de EE.UU.):

- latencia **p50 286 ms · p95 385 ms · máx 751 ms**, con cap 6;
- 164 requests en **8,5 s**;
- 80.820 tokens de entrada = **USD 0,0034** la corrida entera.

**Conclusión operativa:** el paso 0 está cerrado y da verde. Quedan dos bloqueos del §10 —`npm install` para poder correr la suite, y nada más—, y el orden de implementación no cambia: primero los spans (1 y 2), que no necesitan Jev, después `DecisionProvider` (3) y I4 (4), que es el que tiene baseline exacto.
