# CLAUDE.md — src/lib/computo (y hermanos rubros/, hallazgos/)

El corazón del producto: motor de cómputo **puro** (sin I/O, sin DB, sin fetch). Recibe entidades + plantilla de rubro + tipo de obra; devuelve ítems de cómputo e hallazgos. Todo determinístico y testeable sin mocks.

## Principios que el código tiene que hacer cumplir (PRD §2 y §12)

- **P2 — cantidad neta ≠ cantidad de compra.** Cada ítem lleva: `cantNeta` (lo que la obra necesita), `desperdicioPct` (default por material, configurable), `cantCompra` (redondeada HACIA ARRIBA a presentación comercial). `cantCompra = ceilAPresentacion(cantNeta * (1 + desperdicioPct/100))`. Nunca redondear hacia abajo; nunca computar compra sin desperdicio.
- **P3/P4 — taxonomía estricta (§11):** todo dato requerido por el checklist de un rubro cae en exactamente una clase: `explicito` | `deducible` | `supuesto` | `existente` | `faltante`. Lo no resuelto genera un hallazgo, jamás un valor inventado. Confianza < 0.7 degrada a consulta (regla de oro b).
- **Reforma:** entidades con `estadoReforma: 'existente'` **no se computan**; `'demoler'` computa solo demolición/retiro; `'nueva'` computa completo.
- **Estructural/seguridad (RF-506):** cualquier dato de esa índole va a hallazgo `"consultar profesional competente"`, nunca a auto-cómputo.

## Estructura

- `unidades.ts` — conversiones y formateo (m, m², ml, l, kg, u). Redondeos SIEMPRE con 2 decimales para netos; enteros para unidades de compra.
- `presentacion.ts` — `ceilAPresentacion(cantidad, presentacion)`: placas (2,88 m² la placa 1,20×2,40), latas de pintura (1/4/10/20 L, greedy de mayor a menor), barras (unidad), bolsas, u.
- `engine.ts` — `computarRubro(entidades, plantilla, tipoObra, laminas?, datosObra?): { items, hallazgos }`. Es la única entrada pública del motor. Desde F5 lleva la cuenta del **origen por campo** (`Map<entidadId, Map<campo, Origen>>`) y le pone al ítem el **peor** origen de los campos que usó: `explicito < supuesto < deducido < inferido`. Un ítem con `{largoM: explicito, alturaM: deducido}` sale `deducido`.
- `medicion.ts` — medir el dibujo a escala: `medidaGrafica(bbox, paginaPts, '1:N')`, con `metros = pts/72 × 0,0254 × N`. Es la inferencia más débil del sistema y el código la trata como tal (confianza 0,5 fija, ítem `inferido`). **Sin escala no se mide**, y en planta el bbox no dice qué lado es el largo: `largoDelDibujo` solo devuelve un número si el rectángulo tiene una relación de aspecto ≥ 3, porque un bloque casi cuadrado no dice para dónde corre el muro.
- `unificar.ts` — dos filas del mismo elemento en dos láminas son UNA cosa. Agrupa por `entidades.elemento_id`, que escribe el cruce.
- `tags.ts` — `normalizarTag`, **módulo hoja sin imports**: lo usan el motor y la regla de deducción, y traerlo de la regla arma un ciclo que rompe en runtime con `tsc` verde.
- `sanity.ts` — verificaciones cruzadas. En F0 hay una: m² de piso ≈ m² de cielorraso del mismo ambiente (±10%). Devuelve hallazgos tipo `inconsistencia`, no excepciones. Pendiente para F1: `ml zócalo ≈ perímetro − vanos` (PRD §12) — no está implementada, no la des por hecha.
- `../rubros/` — datos de los **ocho** rubros: plantilla (qué se computa y cómo) + checklist de completitud (qué debe estar documentado). Los checklists son **datos editables**, no lógica: agregás un campo al checklist, no un `if` al engine. `respaldo.ts` es la **cadena de respaldo** de un campo de medida: atributo de la entidad → dato de obra que aplique (sumando sus fuentes al ítem y su origen al campo) → **UN** hallazgo agrupado para todas las entidades a las que les falta el mismo hecho. El valor del dato de obra **no se copia a la entidad**: entra al cálculo y queda declarado de dónde salió.
- `../hallazgos/` — `clasificarHueco()` (taxonomía §11) y `puedeAprobarRubro()` (RF-404: false si hay hallazgos abiertos bloqueantes del rubro).

## Reglas de trabajo

1. **Test-first, sin excepciones.** Cada regla de negocio nueva entra con su test con números concretos (ej.: 10 m² de tabique con 10% desperdicio → 11 m² → 4 placas). Los tests de este módulo no tocan DB ni fs.
2. Cada ítem que produce el engine lleva `fuentes` (heredadas de las entidades de origen) y `origen`. Un ítem sin fuentes rompe el contrato — hay un test que lo garantiza; no lo borres.
3. Los defaults de desperdicio viven en la plantilla del rubro (cerámicos 10%, placas 10–15%, pintura por rendimiento y manos, hierro por despiece) — nunca hardcodeados en el engine.
4. Agregar un rubro nuevo = agregar un archivo en `rubros/` + fixtures + tests. El engine no se toca.
