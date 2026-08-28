# El expediente como conjunto — diseño

**Fecha:** 2026-08-28 · **Estado:** aprobado por Manu (conversación 2026-08-28)
**Origen:** feedback de uso real ("me pregunta la altura del techo muro por muro cuando la respuesta está en el corte") + el prompt maestro de lectura de documentación del arquitecto (§ referencias abajo).

## 1. Problema

El pipeline analiza cada lámina por separado y saca conclusiones por separado. Si a cuatro tabiques les falta la altura, la bandeja abre **cuatro** consultas — y la respuesta era una sola y estaba escrita en el corte C-01. La información de una obra vive distribuida entre plantas, cortes, planillas y cuadros; leer lámina por lámina sin cruzar es la causa raíz de que la bandeja se llene de preguntas que la documentación ya responde.

Los mecanismos existentes (deducción §11, búsqueda dirigida, índice de láminas en el contexto) son **reactivos y fragmentados**: primero se generan las N consultas y después se intenta tapar cada una. Hay que invertir el orden — la secuencia del §25 del prompt maestro: inventariar → extraer → **cruzar** → validar → recién entonces computar y preguntar solo lo que de verdad no está.

## 2. Objetivo

El arquitecto sube los planos y obtiene **el listado completo de lo que hay que computar, con cantidades y precio estimado**, donde cada valor lleva su nivel de evidencia y su fuente. Las preguntas de la bandeja se reducen a lo genuinamente no documentado, deduplicadas por dato.

## 3. Decisiones tomadas (no reabrir)

1. **"Valor estimado" = cantidades + precio.** El precio sale del estudio (lista de precios importada/manual) o del índice de compulsas — **jamás de la IA**: un precio "de memoria" en pesos argentinos está vencido antes de escribirse. Sin fuente de precio → vacío honesto.
2. **Todo dato con fuente o método entra directo al cómputo, marcado.** El default deja de ser "proponer y esperar el click": lo explícito, lo deducido (citando fuente) y lo inferido (citando método, confianza baja) entran de una; la bandeja pasa de compuerta a **revisión**. P4 se mantiene en su forma fuerte: nada sin fuente ni método declarado entra jamás, y **nada estructural ni de seguridad entra solo** (RF-506 intacto: la whitelist `CAMPOS_DEDUCIBLES` sigue mandando).
3. **Enfoque B**: extracción en paralelo + pasada de cruce global sobre la memoria en texto + relecturas dirigidas. Ni secuencial (lento, dependiente del orden) ni "todo el PDF en una llamada" (irrecuperable por partes).
4. **Rubros**: se agregan **terminaciones, sanitaria, eléctrica y demolición** a los 4 existentes. La memoria registra todo lo que las láminas digan, de cualquier disciplina.
5. **Una pregunta por dato, no por entidad**: un dato de obra faltante (altura de local) abre UNA consulta que lista los afectados; responderla propaga.

## 4. Arquitectura: el pipeline por fases

`procesarDocumento` pasa de "una lámina a la vez, a ciegas" a cinco fases; `obras.analisis_json` registra la fase en curso y la UI del expediente la muestra ("analizando 12/25", "cruzando información", "releyendo 2 láminas").

1. **Inventario** (§25.1): una pasada barata y paralela lee SOLO los rótulos (`inventariar`, método nuevo del provider, prompt corto sin entidades) → el índice completo del expediente existe antes de extraer nada.
2. **Extracción en paralelo** (pool propio, cap 4 simultáneas, sin dependencias nuevas): cada lámina se analiza con el índice completo en su `ObraContexto`. Las reglas de escala vigentes no cambian.
3. **Cruce global**: primero corren las reglas deterministas del §11 (sin tocar), después UNA llamada de la familia nueva `cruce-*` sobre la **memoria compacta** en texto (sin PDFs): resuelve datos de obra, completa Nivel B citando fuente, unifica identidades (`elemento_id`), detecta contradicciones (§17) y arma la lista de relecturas.
4. **Relecturas dirigidas**: la búsqueda dirigida existente, alimentada además por la lista del cruce. Cap 8, marcas de "ya busqué" por huella — todo como hoy.
5. **Cómputo final**: recompute con niveles de evidencia y precios; memoria MD regenerada; resumen. Hallazgos solo para Nivel D, conflictos y estructural/seguridad.

## 5. Componentes

### 5.1 Memoria de obra (`src/lib/memoria/`)

- **`compacta.ts`** (puro, con tests): serializa el estado de la obra a texto para el cruce — índice de láminas, entidades por lámina (tipo, nombre, atributos, estadoReforma), datos de obra ya resueltos, deducciones aplicadas, hallazgos abiertos (qué falta y dónde). Es la entrada del provider de cruce.
- **`render.ts`** (puro, con tests): el MD descargable (§27 del prompt maestro): documentación analizada, datos de obra, elementos consolidados, relaciones documentales, conflictos, información faltante, datos inferidos con método, nivel de confianza general. Route `GET /api/obras/[obraId]/memoria` → `.md`. Se regenera con cada recompute; la de deducciones (`deduccion/memoria.ts`) queda como sección adentro.

### 5.2 Datos de obra (`datos_obra`, tabla nueva)

Hechos que valen para toda la obra, no para una entidad: `UNIQUE(obra_id, clave)`, con `valor_json {valor, unidad?}`, `origen` (mismo enum de ítems), `fuentes_json`, `confianza`, `metodo` (texto, para inferidos), `definido_por` (usuario, si lo cargó/corrigió a mano — un dato definido por usuario no se pisa jamás por pipeline).

Claves convencionales: `altura_local.<nivel|general>`, `nivel.<nombre>`, `altura_revestimiento.<ambiente|general>`. Las plantillas de rubro reciben los datos de obra resueltos y los usan como respaldo cuando a la entidad le falta el campo (cadena: atributo explícito → dato de obra → inferencia gráfica → pregunta).

Un dato faltante que afecta a N entidades abre **un** hallazgo con `target_dato {clave, entidades[]}` (columna nueva en `hallazgos`); responderlo escribe `datos_obra` y el recompute propaga.

### 5.3 Provider de cruce (`analysis/cruce-{tipos,mock,claude}.ts`, quinta familia)

`cruzar(memoriaCompacta, ctx): ResultadoCruce` con salida estructurada (cable laxo + saneo, patrón de las otras familias):

- `datosObra[]` — clave, valor, lámina citada por **código** (el modelo no conoce uuids; el saneo resuelve código→laminaId y descarta lo irresoluble), bbox si la tiene, confianza.
- `completados[]` — entidad (lámina+nombre), campo, valor, fuente, confianza. **Solo campos de `CAMPOS_DEDUCIBLES`** — el saneo descarta el resto (RF-506).
- `identidades[]` — grupos de entidades que son el mismo elemento físico (§15).
- `conflictos[]` — dato A/fuente A vs dato B/fuente B, causa posible (§17).
- `relecturas[]` — lámina + qué buscar (alimenta la fase 4).

Mock por fixture `tests/fixtures/analysis/cruce/<slug-obra>.json`; sin fixture → resultado vacío. El real registra tokens en auditoría (`cruce_llm`).

### 5.4 Cómo entra lo deducido: auto-validación de deducciones

**Se recicla el rail existente** (`deducciones` + `aplicarDeduccionesValidadas` + `CamposDeducidos` → ítem `origen='deducido'`): lo que cambia es que una deducción con `confianza ≥ 0,7` (determinística o del cruce, regla nueva `'cruce'`) se **auto-valida** — `estado='validada'`, `validado_por = null` (= sistema) — y el atributo se aplica en la misma corrida. Reversible: la bandeja de revisión permite **rechazarla**, lo que revierte el atributo y reabre el faltante. Bajo 0,7 → queda `propuesta` como hoy. Los datos de obra del cruce siguen la misma lógica (≥ 0,7 se escriben con origen `deducido`; abajo, propuesta en revisión).

### 5.5 Inferencia gráfica (Nivel C) (`computo/medicion.ts`)

`medidaGrafica(bbox, tamanoPaginaPts, escala) → metros` (1 pt = 1/72"): puro, con tests pinneados. El pipeline la usa al extraer, para entidades con campos de medida faltantes en láminas con escala utilizable, creando deducciones `regla='medicion_grafica'`, `confianza = 0,5` fija, `metodo` explícito ("medición gráfica sobre el dibujo a escala 1:50"). Se auto-validan **por regla propia, no por umbral**: el 0,7 del §5.4 gobierna a las deterministas y al cruce; la medición gráfica entra siempre (decisión 2: inferido también entra directo) pero **siempre** con origen `inferido` en el ítem, y solo como último respaldo de la cadena del §5.2. Solo medidas lineales/superficies simples; nunca recorridos de instalaciones.

`Origen` gana el valor `'inferido'` (append al pgEnum). El mapa `CamposDeducidos` pasa a llevar el origen por campo; el ítem sale con el peor origen de sus campos (explicito < deducido < inferido). Badges en planilla y export: columna nivel de evidencia + fuente/método.

### 5.6 Precios (`src/lib/precios/` + tabla `precios_referencia`)

- `precios_referencia(estudio_id, clave_item UNIQUE por estudio, descripcion, unidad, precio, moneda, fecha, origen csv|manual)`. Import CSV con preview y errores por línea (patrón proveedores) + alta manual, en `/estudio/precios`.
- `resolverPrecio(item, lista, indice)` puro y pinneado: precio manual del ítem → lista del estudio (match por `clave_item`) → índice p50 si `n ≥ 1` → `null`. Resultado en `computo_items.precio_json {unitario, moneda, fuente, fechaPrecio}`, calculado en el recompute.
- Planilla: columna precio con fuente y fecha, subtotal por rubro, total estimado de obra. XLSX ídem.

### 5.7 Rubros nuevos (4 plantillas, patrón existente: dato + puro + TDD)

`RubroId` += `terminaciones | sanitaria | electrica | demolicion` (append a `RUBROS`; el `satisfies` obliga a completar etiquetas y `PLANTILLAS`). `TIPOS_ENTIDAD` += `tramo`, `accesorio`, `boca` (append, ALTER ADD VALUE).

- **Terminaciones**: desde `ambiente` (atributos nuevos: `solado`, `zocalo`, `cielorraso`, `revestimiento`, `alturaRevestimientoM`, `nivel`) y `terminacion`: m² de solado por material, ml de zócalo (perímetro), m² de cielorraso, m² de revestimiento (superficie por altura), contrapiso y carpeta (= m² de solado).
- **Sanitaria**: `tramo` (sistema af|ac|cloacal|pluvial, diametro, longitudM, material), `accesorio` (tipo codo90|codo45|te|valvula, sistema, diametro), `artefacto`: ml de cañería por sistema+diámetro, accesorios por unidad, artefactos por unidad. Control §22: artefacto sin desagüe correspondiente → inconsistencia no bloqueante, jamás auto-completado.
- **Eléctrica**: `boca` (tipo toma|luz|caja|tablero|datos, circuito?): unidades por tipo. Metros de cable: fuera de alcance (inferirlos sería inventar).
- **Demolición**: entidades con `estadoReforma='demoler'`: m² de muro/tabique (largo × altura, con datos de obra como respaldo de altura), carpinterías a retirar (u), solados a levantar (m²).

Checklists default para los 4; `overrides.ts` y la config del estudio aplican igual. El prompt de extracción (`claude.ts`) aprende los tipos nuevos y sus atributos.

### 5.8 Bandeja: de compuerta a revisión

Dos solapas:

- **Preguntas** — hallazgos abiertos: Nivel D (incluidos los de dato de obra), conflictos documentales, estructural/seguridad, escala. Lo único que espera algo del arquitecto.
- **Para revisar** — deducciones auto-validadas (`validado_por IS NULL`) e inferidos, con fuente/método y botón **rechazar** (revierte y reabre). Informan; no bloquean.

Aprobar un rubro (RF-404) sigue exigiendo cero bloqueantes; el aprobado registra en auditoría cuántos deducidos/inferidos incluía.

## 6. Cambios de comportamiento asumidos

- **El golden 2 cambia de esperado**: la deducción `planilla_plano` que hoy queda `propuesta` pasa a aplicarse sola, así que aparecen ítems que antes no estaban. Es un cambio de producto deliberado y documentado — la única excusa válida para tocar un expected.
- La bandeja de deducciones existente (`/deducciones`) se integra a la solapa "Para revisar" (la pantalla vieja redirige).
- El costo por obra sube ~el doble (inventario + cruce + prompts más ricos): ~US$2–4 por 25 láminas, todo auditado por fase (`analisis_llm`, `cruce_llm`, `busqueda_llm`).

## 7. Fuera de alcance

DWG/DXF, billing, canales reales de outreach, medición gráfica de recorridos de instalaciones, ml de cable eléctrico, RLS Supabase, paralelismo entre documentos distintos (el pool es por documento).

## 8. Criterios de aceptación

1. Obra sintética "conjunta" (planta con 4 tabiques sin altura + corte con altura 2,60 acotada + planilla + sanitaria): el cómputo sale completo con los tabiques computados `deducido` citando el corte, **cero** consultas de altura; golden 3 la fija.
2. Un dato de obra faltante en toda la documentación → UNA consulta que lista los afectados; responderla propaga a todos los ítems en un recompute.
3. Ítem con precio en la lista del estudio → precio estimado con fuente y fecha; sin lista ni índice → vacío, jamás un número de la IA.
4. Los 8 rubros emiten con fixtures; suite y build verdes; goldens 1 y 2 con expected justificado.
5. Con la obra real SEG2580: la bandeja de preguntas queda en un puñado de consultas reales (criterio de éxito de uso, no de suite).
