# SESSION 2026-08-27 — Proponer en vez de bloquear

El sistema sabía leer el dato y lo preguntaba igual. Esta sesión cambia el default: donde había una consulta bloqueante, ahora hay una propuesta con su fuente y un botón de confirmar. 8 tareas (T0–T5b) en tres olas paralelas por subagentes, con revisión por tarea.

## El problema, tal como llegó

El arquitecto usó el producto con documentación real (obra SEG2580, 25 láminas) y volvió con esto:

- La bandeja se llenó de consultas **bloqueantes** pidiendo datos que la IA podía extraer. Las medidas de FP01 y FP02 están escritas en la planilla de carpinterías (DET00), a dos láminas de distancia.
- La escala que el rótulo **declara** (1:20) igual había que tipearla de cero, y hasta que la tipeara la lámina no se analizaba.
- Textual: *"no es viable si el usuario tiene que cargar todo a mano"*. Y también: *"hoy ni siquiera se puede ver el plano en simultáneo con la pregunta que me está haciendo"*.
- El dato decisivo: **el arquitecto saca esos mismos datos bien con ChatGPT y prompts manuales.** No era un techo del modelo. Era nuestro.

## Las cuatro causas raíz, verificadas antes de tocar nada

Esta es la parte que ya no se deduce leyendo el código, porque el código dejó de decirlo:

1. **El prompt pedía `entidades: []` para las planillas.** El SISTEMA de `claude.ts` terminaba instruyendo que una planilla, una carátula o una memoria devolvieran el rótulo y `entidades: []`. La lámina donde el estudio escribe las medidas que la planta no trae se salteaba **entera**.
   La consecuencia de segundo orden es la que costó ver: la regla de deducción `planilla_plano` (F2, §11) **nunca pudo disparar con planos reales** — necesita entidades de los dos lados y uno de los dos venía vacío siempre. El golden 2 pasaba a 0,00 % porque su fixture del mock **sí** trae las entidades de la planilla. Una regla con test verde y cero efecto en producción, invisible desde los tests por construcción.

2. **`ObraContexto` nunca llegaba al prompt.** `claude.ts` resuelve la lámina entera en **una** llamada y cachea la promesa por `laminaId`; el pipeline pide el rótulo **antes** que las entidades, y `leerRotulo` no tenía parámetro de contexto. Resultado: el prompt que efectivamente se mandaba era siempre el de la primera llamada, o sea el que no tenía contexto — y la fila de `auditoria` (`analisis_llm`) quedaba sin `obraId`. Estaba anotado en el HANDOFF §8 como "el cache que pisa `ObraContexto` en reformas"; la forma real era peor que la nota.

3. **No existía "valor propuesto" en hallazgos.** Tres canales paralelos (hallazgos, deducciones, entidades) y solo `deducciones` portaba un candidato. Una medida leída con confianza < 0,7 quedaba persistida en `entidades.atributos_json` y el gate la tiraba: el sistema tenía el número y preguntaba igual, sin mostrarlo.

4. **`targetRef` apuntaba a UN campo** (`faltantes[0]`). Responder el ancho hacía aparecer una consulta nueva por el alto.

## Los hallazgos de revisión que valieron la plata

### CRITICAL (T4) — la consulta multi-campo se cerraba con la mitad del dato

Al abrir `targetRef` a varios campos, ni `responderHallazgo` ni `confirmarLote` verificaban que estuvieran **todos** los campos de `camposDelTarget()`. Validaban que las claves enviadas pertenecieran a la consulta (subconjunto) y que los valores fueran positivos, pero nunca que no faltara ninguno. Como `recomputarObra` **no reabre un hallazgo cerrado** (regla 3 de `recomputar.ts`), escribir el ancho y cerrar la consulta **perdía el alto para siempre**: sin ítem, sin consulta que lo volviera a pedir, y sin una línea en la auditoría que dijera que algo quedó sin cargar. Silencioso, permanente, y garantizado a ocurrir en cuanto la búsqueda dirigida encontrara una medida y la otra no.

Dos cosas lo hacen valioso más allá del fix:

- **Se verificó ejecutando el código, no razonando sobre él.** El escenario no era hipotético.
- **El implementador encontró un tercer camino con la misma causa raíz** que la revisión no señalaba: el payload viejo de `valor` suelto sobre un target de dos campos. No hay forma de saber cuál de las dos medidas es ese número, y escribir la primera cierra la consulta igual. Buscar la causa en vez de aplicar el parche es lo que lo encontró.

Además, el comentario que documentaba el comportamiento viejo como intencional ("una propuesta parcial confirma lo que tiene") **estaba mal** y se reescribió. Un comentario que justifica un bug es peor que ninguno.

Regla que quedó: **una consulta se responde con todas sus medidas o no se responde**; ni el campo que sí vino se escribe. Una propuesta incompleta se saltea en el lote y queda viva en la consulta abierta para que la complete una persona.

### Important (T3) — ventana TOCTOU entre releer y escribir

`busqueda.ts` releía el hallazgo, chequeaba `estado === 'abierto'` y recién después hacía el `UPDATE ... WHERE id = ...`. Entre las dos llamadas el arquitecto podía responder o descartar la consulta desde la bandeja y la propuesta se escribía igual sobre un hallazgo cerrado. La condición se movió **al `WHERE`** (mismo patrón que la invariante del último titular en `plataforma/usuarios.ts`); cero filas es *no-propuesto*, no un error, y la clave queda contada en la auditoría de la corrida. El chequeo en memoria se conservó porque evita el `UPDATE` en el caso normal y distingue el motivo.

Del mismo review salió que `zValorPropuesto` estaba declarado y **nadie lo invocaba**: `deps.provider` es inyectable y `DatoEncontrado` es una interfaz de TypeScript, así que un provider con un bug podía meter `confianza: 3` en la columna. El saneo es la disciplina **del provider**; el zod es la **del pipeline sobre la base**. Se agregó con `safeParse` y descarte contado — la búsqueda es aditiva y una propuesta inválida tiene que dejar la consulta como estaba (una pregunta honesta), no tirar abajo la corrida.

### Trampa (T0) — el ciclo de imports que rompe en runtime con `tsc` y unit tests verdes

`normalizarTag()` lo necesitan la regla `planilla_plano` **y** `rubros/aberturas.ts`. Importarlo desde `deduccion/reglas/planilla-plano.ts` metía `deduccion/motor.ts` en el grafo del motor de cómputo. `motor.ts` arma su tabla `IMPLEMENTACIONES` en el cuerpo del módulo, y con el ciclo el módulo de las reglas quedaba a medio evaluar cuando esa tabla se construía:

> `TypeError: IMPLEMENTACIONES[regla] is not a function` — **en runtime**, con `tsc --noEmit` limpio y los tests unitarios en verde. Apareció recién en un test de integración.

Por eso vive en **`src/lib/computo/tags.ts`**, un módulo hoja sin imports, re-exportado desde la regla. Si alguien "ordena" el import de vuelta, vuelve a romper igual de tarde.

## Las decisiones de diseño, con su razón

**1. La escala declarada deja de bloquear; solo `escala: null` bloquea.** Tres salidas en vez de dos: `confiable` (cierra la consulta), `asumida` (la lámina se **analiza y computa**, y la consulta pasa a `supuesto` no bloqueante con la escala del rótulo como propuesta), `bloqueada` (sin escala declarada, exactamente como antes). El razonamiento: una escala que el rótulo declara y no se pudo verificar contra cotas es un *supuesto*, no una ausencia; tratar las dos igual le cobraba al arquitecto el precio de un dato faltante por un dato que estaba escrito. El testigo de que funciona es un número del motor: `escala-declarada.pdf` produce `seco.placas` con `cantCompra` **25,92** — si la lámina se bloqueara no habría ningún ítem.

**2. `valorPropuesto.valores` es plural** (`Record<campo, valor>`), no un valor suelto. Porque una tarjeta lleva el **ancho y el alto juntos**: la consulta nace de una abertura sin acotar y responderla de a un campo es lo que producía la reaparición del punto 4 de arriba. El plural en el contrato es lo que hace posible la regla "todas las medidas o ninguna".

**3. Confirmar un `*.baja_confianza.*` sube `entidades.confianza` a 1.** Sin esto la confirmación no sirve para nada: el gate de `computarRubro` mira la confianza **de la entidad**, no la del hallazgo, así que el ítem seguiría degradado y nunca se emitiría. Es el caso donde la propuesta más barata del sistema (el dato ya está leído, solo hay poca confianza) sería la única que no funciona.

**4. La búsqueda dirigida SOLO propone; jamás escribe atributos** (P4). Encuentra el dato en otra lámina, lo deja en `valor_propuesto_json` con su `fuente` y su confianza, y ahí se queda. El dato entra a la entidad **únicamente al confirmar**, por la misma puerta que una respuesta escrita a mano. Un test pinnea que `atributos_json` queda intacto después de una corrida con hallazgo encontrado.

**5. La marca de "buscado sin resultado" caduca por huella de contenido, no por reloj.** Sin marca, una obra con una consulta que la documentación no puede contestar re-paga hasta 8 llamadas en **cada** `procesarDocumento` (la idempotencia por `valor_propuesto_json IS NULL` solo cubre lo que sí se encontró). La marca vive en una columna propia (`hallazgos.busqueda_json`) y no dentro de la propuesta, porque una propuesta dice *qué proponer* y esto dice que *no hay nada que proponer*: compartir columna obligaría a todo lector de propuestas a distinguirlas, y el primero que se olvide le muestra al arquitecto una tarjeta "confirmá esto" vacía.
Y caduca por **huella**, no por tiempo, porque el dato no aparece porque pasen los días: aparece porque el arquitecto sube el plano que lo tiene. La huella es un sha256 sobre `id|tipo|estadoAnalisis|textoExtraido` de **todas** las láminas de la obra. No cambia al reprocesar el mismo documento (ese era el gasto a cortar) y sí cambia con una lámina nueva, con una que pasó de `bloqueada_escala` a `analizada` (recién ahí es candidata a releerse) o con una revisión que cambió el texto. Entra el texto completo y no su largo: una cota reemplazada por otra deja el largo igual y tiene que caducar igual. Y es la huella de la obra entera, no la de las candidatas leídas: una lámina nueva puede cambiar **cuáles** son las candidatas.

**6. La planilla de carpinterías extrae una entidad `abertura` por fila**, con el `bbox` de la fila. Es la contracara exacta de la causa raíz 1. `cantidad` de la planilla es informativa y **no computa**: cuántas se compran lo dice la planta. Carátulas, memorias e índices siguen con `entidades: []` — la regla no era "no leas planillas", era "no inventes", y una tabla de datos escritos no es una invención.

**7. `confirmarSupuesto` rechaza las claves `escala.*`.** Cerraría el hallazgo sin marcar `escala_confiable`, y la lámina quedaría computada con una escala asumida y sin consulta que lo dijera. El botón correcto es "Confirmar escala", que pasa por `actualizarLamina`.

**8. Lo que el arquitecto cerró no se reabre — tampoco la consulta de escala.** Se sacó la rama que la reabría "porque la lámina sigue sin escala confiable": `escala_confiable` es de una sola vía en `fusionarRotulo`, así que la única forma de tener una consulta cerrada con la lámina sin confirmar es que él la haya **descartado a propósito**. Insistir en cada reproceso con una pregunta ya contestada es peor que no preguntar. Consecuencia honesta: `hallazgo_reabierto` ya no lo emite nadie en el pipeline (la etiqueta de la pantalla de auditoría queda para las filas viejas).

**9. La escala confirmada a mano gana sobre la del rótulo.** Mini-fix en `fusionarRotulo` que la decisión 1 volvió obligatorio: el supuesto se cierra con "confirmala o **corregila**", y sin esto un `1:25` corregido a mano duraba hasta el próximo reproceso, que volvía a escribir el `1:20` del rótulo sin avisarle a nadie.

**10. Confirmar la misma escala no vuelve a llamar al modelo.** `actualizarLamina` reprocesa solo si la lámina **no está analizada** (no tiene entidades: sin re-análisis no hay cómputo) o si la escala **cambió de valor** (todo lo medido se midió con la anterior). El corte quedó por "no analizada" y no por "bloqueada" porque una lámina en `error` o `pendiente` tampoco tiene nada extraído, y cerrarle la consulta sin reprocesar la dejaba fuera del cómputo sin nada que lo explicara. Pinneado con el contador de auditorías `lamina_procesando`: **1** al confirmar, **2** al corregir.

**11. El corte anticipado de la búsqueda es económico, no cosmético.** Las candidatas van con las **planillas primero** y la corrida se corta apenas no queda ningún campo pendiente. En la obra de fixture las candidatas son dos y se consulta **una**: el usuario paga estos créditos. Consecuencia de diseño anotada: "por campo gana la mayor confianza" se resuelve dentro de la respuesta de **una** lámina, no entre láminas.

**12. La bandeja embebe el visor en vez de navegar.** Confirmar un número que el sistema dice haber leído en algún lado, sin ver ese lado, es firmar a ciegas. El chip que se abre primero es la lámina de la **propuesta** (DET00), no la citada (A-01): la citada muestra el hueco del que se pregunta, la de la propuesta muestra la fila de la que salió el dato.

## Cómo terminó

**1077/1077 tests en 67 suites · golden 2 casos al 0,00 % (máximo y promedio, los cuatro rubros de cada uno) · `tsc --noEmit` limpio.** Verificado sobre `81fe3b9` al cierre de esta sesión; una tarea hermana (`task/w3fix`) estaba sumando tests en paralelo, así que el número sube.

Ningún número del motor se movió: la sesión no toca el cómputo salvo `normalizarTag`, que es no-op con tags consistentes. Dos migraciones de una línea cada una (`0003` propuesta, `0004` marca de búsqueda), sin tabla nueva — la cadena de `eliminarObra` queda intacta.

**Lo que NO se verificó:** el recorrido e2e en navegador y la prueba con la obra real. Ver el handoff efímero.

## Lo que quedó afuera, a propósito

- **Paralelizar `procesarDocumento`.** Sigue secuencial y con 25 láminas reales se hace largo, y ahora encima suma la búsqueda dirigida al final del request de upload. Es la misma deuda de F0 y esta sesión la empeoró un poco a cambio de la propuesta; sacarla del request es un follow-up con forma propia, no un ajuste.
- **Ningún ítem queda marcado como "computado sobre escala asumida".** El aviso vive en la bandeja, que es donde está la consulta, pero **no** en la planilla donde el arquitecto mira los números. Es la deuda más visible que deja la decisión 1 y quedó anotada, no resuelta.
- **Ninguna heurística sobre `textoExtraido` cuando no hay fixture.** El mock de búsqueda devuelve `[]` y no cae a un match por palabras: un match así no sabe cuál de los números de la fila es el ancho ni dónde está su bbox, y adivinarlo sería una propuesta con provenance inventada. Justo lo que P4 prohíbe.
- **El bbox se valida con 4 números finitos, no con área positiva.** Es el contrato acordado; si un bbox degenerado molesta en el visor, el lugar de arreglarlo es `sanearBusqueda`, una línea.
- **Los componentes de cliente siguen sin tests de render.** El repo no tiene `@testing-library/*` ni entorno jsdom, y `package.json` estaba congelado para esta ola. `PanelVisor`, la tarjeta de la bandeja y el split view quedan cubiertos por `tsc`, por los helpers puros extraídos (`laminasDeConsulta`, `destacadosDeConsulta`, `armarMirada`, 15 pins) y por el e2e que **todavía falta correr**.
- **`claude.ts` y los providers reales siguen sin tests** — no sale red en la suite, por regla del repo. Por eso todo lo testeable del prompt se mudó a `prompt.ts` (puro, un solo import). El texto del prompt de planillas solo se valida contra la API real: es el paso pendiente con la obra del usuario.
