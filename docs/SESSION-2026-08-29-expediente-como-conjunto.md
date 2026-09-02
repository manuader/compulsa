# Sesión 2026-08-29 — El expediente como conjunto

**Qué la disparó:** un comentario del usuario después de usar el producto con documentación real.

> «Me pregunta la altura del techo muro por muro cuando la respuesta está en el corte.»

Esa frase es el diagnóstico completo. El sistema analizaba **una lámina a la vez** y computaba con lo que esa lámina traía escrito encima. Pero una obra no se documenta así: la planta dibuja los tabiques y **no les acota la altura**, porque el corte la acota una vez para todo el nivel. Leyendo lámina por lámina, cada tabique era un hueco; cuatro tabiques del mismo local eran cuatro preguntas idénticas con la misma respuesta, y el arquitecto contestaba cuatro veces lo que la documentación ya decía una.

La ola cambia el sujeto del análisis: **de la lámina al expediente**.

Spec: [`docs/superpowers/specs/2026-08-28-expediente-como-conjunto-design.md`](superpowers/specs/2026-08-28-expediente-como-conjunto-design.md). Plan: 12 tareas, siete de ellas en paralelo en la primera ola, ejecutadas en worktrees.

---

## 1. Las siete cosas que cambiaron

### 1.1. El pipeline tiene cinco fases, y se ven

`procesarDocumento` pasó de «una lámina a la vez, a ciegas» a **inventario → extracción → cruce → relectura → listo**, con la fase en curso escrita en `obras.analisis_json` y mostrada en `/obras/[obraId]/expediente` con polling suave hasta que termina.

- **Inventario:** una pasada corta y paralela que lee **solo rótulos**, para que la extracción de cada lámina arranque con el índice del expediente completo en su `ObraContexto`. Es una llamada barata al modelo (`inventariar()`), separada del caché de extracción justamente para no pagar la cara dos veces.
- **Extracción:** en paralelo, con cap 4 (`enParalelo` de `pipeline/pool.ts`, `PARALELISMO_ANALISIS` por env). Un rechazo no tira el lote.
- **Cruce:** la novedad. Ver 1.2.
- **Relectura:** la búsqueda dirigida vuelve a las láminas que el cruce pidió releer.

### 1.2. El cruce: la obra mirándose a sí misma

Una quinta familia de providers (`src/lib/analysis/cruce-*.ts`) que **no mira una lámina**: recibe la memoria compactada de toda la obra (`src/lib/memoria/compacta.ts`) y devuelve cinco listas — datos de obra, campos completados, identidades, conflictos y relecturas pedidas. Una llamada por obra, la más grande del pipeline.

Tres decisiones que valen la pena:

- **Cita las láminas por código de rótulo, no por uuid**, porque es lo único que el modelo lee. `sanearCruce` los resuelve contra el expediente real y **descarta contando** lo que no resuelve.
- **`cruzar()` devuelve el crudo**, al revés que las otras cuatro familias: el saneo necesita el mapa de códigos y las entidades, que son cosas de la base. Un solo saneo, río abajo, el mismo para el mock que para el modelo.
- **Sin bbox usable, la fuente es la lámina completa** — la diferencia deliberada con la búsqueda dirigida. El modelo cruza sobre un texto compactado que ya no tiene los PDFs delante; exigirle coordenadas sería pedirle que las invente.

### 1.3. Los datos de obra y la cadena de respaldo

La pieza que contesta la frase del usuario. Un **dato de obra** es un hecho que vale para toda la obra: `altura_local.PB`, `altura_revestimiento.general`, `nivel.PB`. No pertenece a ninguna entidad, y por eso no vive en `atributos_json` sino en su propia tabla, con su origen, su confianza, sus fuentes y `definido_por`.

Las plantillas ya no leen el atributo y se rinden. Leen por la **cadena de respaldo** (`src/lib/rubros/respaldo.ts`):

1. el atributo de la entidad;
2. el dato de obra que aplique, del más específico al más general (`altura_local.PB` → `altura_local.general`), **sumando sus fuentes al ítem** (P1: la altura la dice el corte, y el ítem tiene que citarlo) y su origen al campo;
3. si tampoco hay, **UN** hallazgo para todas las entidades que esperan el mismo hecho, con `targetDato` en vez de `targetRef`. Responderlo escribe `datos_obra` y el recompute lo propaga.

Cuatro preguntas idénticas pasaron a ser una. Y el valor del dato **no se copia a la entidad**: entra al cálculo y queda declarado de dónde salió. Copiarlo no cambiaría ningún número y sí haría creer que la documentación dice algo que no dice.

### 1.4. Lo deducido entra al cómputo, marcado y reversible

Decisión de producto (§3.2 de la spec), y es la que más cambia la sensación de usar el producto. Hasta ahora **toda** deducción esperaba un clic. Ahora:

- una deducción determinista o de cruce con **confianza ≥ 0,70** nace `estado='validada'`, `validado_por=null`, y se aplica en la misma corrida;
- la **medición gráfica** se aplica siempre, con confianza 0,5 fija, y deja el ítem en `origen: 'inferido'`;
- todo lo aplicado solo se ve —y se revierte— en la solapa **«Para revisar»** de la bandeja.

Lo que **no** cambió: nada sin fuente ni método, nada fuera de `CAMPOS_DEDUCIBLES` (RF-506), y la IA **jamás** pone un precio.

El engine ganó el **origen por campo** (`Map<entidadId, Map<campo, Origen>>`) y le pone al ítem el **peor** origen de los campos que usó: `explicito < supuesto < deducido < inferido`. Un ítem con `{largoM: explicito, alturaM: deducido}` sale `deducido`, y la planilla lo dice con un badge y un filtro.

### 1.5. Medir el dibujo, cuando no queda otra

`src/lib/computo/medicion.ts`: `metros = pts/72 × 0,0254 × N` para una escala `1:N`. Es la inferencia más débil del sistema y el código la trata como tal. Dos reglas la sostienen: **sin escala no se mide**, y en planta el bbox **no dice qué lado es el largo** — un tabique dibujado en vertical tiene un rectángulo angosto y alto, y leer su ancho daría el espesor (0,30 m en vez de 6 m), un número plausible que entra al cómputo y nadie mira dos veces. Por eso `largoDelDibujo` exige una relación de aspecto ≥ 3 y, si no la hay, no mide: la cota sigue faltando y la consulta sigue abierta.

### 1.6. Cuatro rubros nuevos: ocho en total

`terminaciones` (solado, zócalo, cielorraso, revestimiento, contrapiso, carpeta), `sanitaria` (cañería por sistema y diámetro, accesorios, artefactos, con el control de correspondencia artefacto ↔ desagüe del §22), `electrica` (bocas por tipo) y `demolicion` (muros, carpinterías, solados). `gruesa.demolicion` se mudó a `demolicion.muros`: el ítem cambió de rubro, no de número.

### 1.7. Precios, por cascada y nunca de la IA

`src/lib/precios/resolver.ts`, puro: **manual del ítem → lista del estudio por `clave_item` exacta → índice p50 del mes más reciente con n ≥ 1 → `null`**. `null` es una respuesta, no una falla: un ítem sin precio sale vacío y el total dice cuántos no está contando. La lista vive en `precios_referencia` y se administra en `/estudio/precios`, a mano o por CSV.

---

## 2. Lo que hizo la tarea de cierre (T12)

### 2.1. El golden 3: la prueba de la ola

`tests/golden/obra-conjunta/` — seis láminas (planta, corte, planilla de carpinterías, sanitaria, eléctrica y cuadro de locales) armadas para que **la planta no acote una sola altura** y el cómputo salga igual completo: **28 ítems en siete rubros, 0,00 % de error**.

El número que prueba la ola no es ninguno de los 28. Es el **cero** de consultas `dato_obra.altura_local.PB` en la bandeja. Con la lógica anterior, la misma documentación abría cuatro preguntas idénticas de altura y no computaba un metro de placa.

Para poder afirmarlo, el harness (`scripts/golden-check.ts`) devuelve dos cosas más, que no entran en el contrato de precisión: el **origen** de cada ítem y las **claves de los hallazgos abiertos**. La cantidad sola no distingue un ítem que salió del cruce de uno que estaba escrito, ni una bandeja vacía de una llena.

El caso corre con `validarDeducciones: false`: nada de esa obra pide un clic.

### 2.2. El rebase de los goldens viejos

El único movimiento autorizado, y quedó documentado línea por línea: `gruesa.demolicion` → `demolicion.muros` en `obra-reforma`. **El número no se movió** (los mismos 10,40 m² de M1: 4 × 2,60). Ningún otro ítem de los dos goldens viejos cambió de valor. Un rebase en el que además se mueve una cantidad no es un rebase: es una regresión disfrazada.

### 2.3. El seed

Una **lista de precios** de diez renglones a nivel estudio, con fecha fija (una fecha que se mueve con el reloj rompería la idempotencia al día siguiente), sembrada **antes** que las obras porque la cascada de precios corre dentro del recompute.

Y una tercera obra, **«Casa Conjunta — demo»**, con las seis láminas. Su nombre a propósito **no** matchea ningún fixture de cruce: sin cruce, la altura no aparece sola, la bandeja abre la consulta agrupada y el seed la responde con 2,60 como lo haría el arquitecto, por `responderHallazgo`. 27 ítems, 10 con precio de lista, los cuatro rubros nuevos poblados, y la otra consulta agrupada —hasta dónde llega el revestimiento del baño— **abierta**, para que la bandeja tenga qué mostrar.

### 2.4. El e2e, y el bug que encontró

Servidor propio en `:3101` sobre el worktree, navegador de verdad. Se verificó de punta a punta: subir la obra fixture → el expediente muestra la fase → la planilla con precios y badges de origen → la bandeja con la consulta agrupada de dato de obra → responderla → **once ítems nuevos en una sola pasada** (seco 0 → 6, gruesa 0 → 4, pintura 1 → 2, con los mismos números del golden) → rechazar una deducción auto-validada → **revierte**: `aberturas.V1` pasa de `Deducido` a `Supuesto` y la consulta bloqueante vuelve a «Preguntas».

Y encontró un bug que **la suite entera de 1582 tests no veía**: la bandeja de cualquier obra con una consulta de dato de obra devolvía 500. Ver §3.

---

## 3. El bug que valió la plata

`fuentesDeAfectadas()` vivía en `bandeja/ui.tsx`, que es `'use client'`, y `page.tsx` —un Server Component— la llamaba.

Lo que un módulo `'use client'` exporta **hacia el server** no es la función: es una referencia serializable que sirve para renderizar como componente o pasar como prop. Llamarla tira **«Attempted to call fuentesDeAfectadas() from the server but fuentesDeAfectadas is on the client»**.

`tsc --noEmit`: limpio. `next build`: verde. La suite: 1582/1582. La pantalla: 500, en la consulta que la ola vino a inventar.

Es la misma familia que la regla 9 del CLAUDE.md (Next valida exports que `tsc` no ve) y que §7.21 del HANDOFF (el `import()` ignorado). El arreglo tiene dos mitades:

1. la pieza pura se mudó a `bandeja/plano.ts`, un módulo hoja sin directiva;
2. `tests/unit/exports-de-next.test.ts` ganó un **cuarto chequeo**: recorre `src/`, resuelve los imports relativos y marca a todo módulo **sin** `'use client'` que **llame** a un nombre exportado por uno que sí la tiene. La distinción entre **llamar** (`ayuda()`) y **renderizar** (`<Comp />`) es la que lo hace útil: importar un componente de un `'use client'` es exactamente para lo que la directiva existe. El chequeo se verificó poniéndole el caso delante antes de dejarlo verde.

---

## 4. Verificación de cierre

| Comando | Resultado |
|---|---|
| `vitest run --maxWorkers=3` | **103 archivos, 1583 tests, 0 fallos** |
| `npm run golden` | **3 casos, 0,00 % de error** — obra-demo 15 ítems, obra-reforma 11, obra-conjunta 28 |
| `npm run build` | verde en el worktree (los dos warnings preexistentes de pdfjs) |
| `npm run seed` | idempotente: la segunda corrida no toca una fila |
| e2e en navegador | el flujo completo, con el bug de §3 encontrado y cerrado |

---

## 5. Deuda que la ola deja anotada

Está en el §8 del HANDOFF general, ítem por ítem. Las que más pesan: la calidad del agrupamiento por `elemento_id` que escribe el cruce **no tiene test** (T10 lo simula a mano), `anotarFallosDelLote` se implementó sin test que lo ejercite, las dos solapas de la bandeja consultan en cada request, y `confirmarLote` hace N recomputes cuando responde datos de obra.
