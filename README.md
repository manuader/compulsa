# Compulsa

Plataforma de análisis documental, cómputo y compulsa de obra para estudios de arquitectura
argentinos. El arquitecto sube la documentación de una obra —plantas, cortes, vistas, planillas de
carpinterías— y recibe el cómputo por rubros en planillas, con cada cantidad trazada hasta la
lámina y el recuadro de donde salió. El sistema separa cada PDF en láminas, lee los rótulos,
detecta ambientes, muros, tabiques y aberturas, y arma la planilla con cantidad neta, desperdicio
y cantidad de compra redondeada a la presentación comercial con la que se compra el material:
placas de 1,20 × 2,40, baldes de 15 kg, cajas de 500 tornillos.

Lo que la documentación no resuelve no se rellena en silencio: se pregunta. Todo hueco —un dato
que falta, una lámina sin escala verificable, un elemento que ya existe en una reforma, una
deducción que no llega al umbral de confianza— cae en la bandeja de consultas, se responde de a un
clic y el cómputo se recalcula solo. Ningún rubro se puede aprobar con una consulta bloqueante
abierta. Ese es el punto: el número que sale de acá se puede llevar al corralón sin que falte ni
sobre material, y se puede auditar hasta el plano.

El documento rector del producto es [doc/PRD.md](doc/PRD.md); las reglas de trabajo del repo están
en [CLAUDE.md](CLAUDE.md).

## Setup

Requiere **Node 21** y npm. No hace falta Docker, ni Supabase CLI, ni ningún servicio externo: en
desarrollo y en tests la base corre sobre PGlite (Postgres embebido, en `data/pglite/`), los
archivos van al disco local (`data/uploads/`) y el análisis usa un provider mock determinístico.
El proyecto corre y se testea entero offline.

```bash
npm install
npm run seed         # datos de demo: estudio, usuario y una obra ya analizada
npm run dev          # http://localhost:3000
```

`npm run seed` es idempotente: corrélo las veces que quieras, no duplica nada. Si querés arrancar
de cero, borrá `data/` y volvé a sembrar.

No hace falta configurar nada, pero si querés apuntar a un Postgres real o habilitar el provider
de análisis de Claude, copiá `.env.example` a `.env.local` y completá `DATABASE_URL` o
`ANTHROPIC_API_KEY`. Sin ninguna variable seteada corre todo local.

### Credenciales de demo

```
mail:       demo@compulsa.ar
contraseña: demo1234
```

Entrás y encontrás la obra **«Casa Belgrano — reforma demo»**: tres documentos subidos, cinco
láminas (cuatro analizadas y una bloqueada por falta de escala), quince ítems de cómputo en los
cuatro rubros, un ítem corregido a mano y la bandeja con una consulta respondida y otra abierta.
Alcanza para recorrer las cinco pantallas sin cargar nada.

### Sin dependencias nativas

El árbol no compila ni descarga binarios nativos propios. `pdfjs-dist` declara `@napi-rs/canvas`
(≈25 MB) como `optionalDependency` para rasterizar páginas; acá sólo se extrae texto, así que el
`overrides` de `package.json` lo apunta a una versión inexistente y npm, al ser opcional, la saltea.
No lo agregues sin necesidad: el día que haga falta rasterizar de verdad hay que sacar ese
`overrides` y asumir el binario, y conviene medir antes si alcanza con el texto (`src/lib/pdf/`).

## Comandos

```bash
npm run dev          # dev server (PGlite local, migra al boot)
npm run build        # build de producción
npm start            # sirve el build
npm test             # vitest (unit + integration) — 252 tests, sin red
npm run test:watch   # vitest en watch
npm run golden       # harness de regresión de precisión contra el golden set
npm run seed         # datos de demo (idempotente)
npm run db:generate  # drizzle-kit generate (tras tocar src/db/schema.ts)
npm run fixtures     # regenera los PDFs y fixtures de prueba
```

No corras `npm run build` con `npm run dev` levantado: comparten `.next/` y se pisan.

## Arquitectura

Next.js 15 (App Router) + React 19 + TypeScript estricto + Tailwind v4, en cuatro capas:

- **Dominio puro** (`src/lib/computo`, `src/lib/rubros`, `src/lib/hallazgos`): unidades,
  desperdicio, presentación comercial, plantillas y checklists por rubro, taxonomía de huecos y
  gate de aprobación. Sin I/O, sin Next, sin base: funciones que reciben entidades y devuelven
  ítems y hallazgos. Es lo que se desarrolla test-first y lo que el golden set protege.
- **Adaptadores** (`src/lib/analysis`, `src/lib/storage`, `src/db`): la IA y los archivos entran
  por interfaz, con implementación mock/local y real (Claude API / Supabase Storage). El core no
  importa SDKs de servicios externos. Drizzle sobre PGlite o Postgres según `DATABASE_URL`.
- **Pipeline** (`src/lib/pdf`, `src/lib/pipeline`): sube el documento, lo separa en láminas de una
  página, extrae texto, pide rótulo y entidades al provider, guarda con provenance y recomputa la
  obra. Idempotente y con estados visibles por lámina; toda escritura queda en `auditoria`.
- **UI** (`src/app`, `src/components`): Server Components por defecto, `"use client"` solo donde
  hay interactividad real (visor, grilla editable, formularios). Cinco pantallas —tablero,
  expediente, visor, planilla, bandeja— más las route handlers de upload y export.

## Estado: F0 (núcleo de cómputo)

Lo que hay hoy, punta a punta:

- Registro de estudio, login y **aislamiento total entre estudios**: una obra ajena no existe (404),
  ni por pantalla ni por API ni por descarga de archivo.
- Alta de obra (nueva / reforma / ampliación) y expediente: upload de PDF, separación por página,
  lectura de rótulo (código, título, disciplina, tipo, escala), reclasificación manual y reproceso.
- **Bloqueo por escala**: una lámina sin escala verificable no se computa y abre una consulta
  bloqueante; cuando el arquitecto confirma la escala, la lámina se re-analiza sola.
- Cómputo en cuatro rubros: **aberturas, construcción en seco, pintura y obra gruesa**, con
  cantidad neta, desperdicio, cantidad de compra y presentación comercial.
- Visor de láminas con overlay de entidades y consultas sobre el plano, capas conmutables y
  resaltado en rojo del ítem que venés a mirar desde la planilla.
- Planilla editable por rubro: edición inline con recálculo server-side, alta y anulación de ítems,
  filtros por origen y aprobación de rubro con confirmación.
- Bandeja de consultas: responder, marcar existente, confirmar supuesto o descartar, de a una o en
  lote, con efecto inmediato sobre el cómputo.
- Export XLSX por rubro y consolidado, con las láminas fuente de cada ítem.
- Auditoría de toda escritura de agente y del usuario, con actor y diff.
- Harness de precisión (`npm run golden`) sobre un golden set: error ≤ 2% por rubro (RNF-1).

### Lo que F0 **no** incluye

- **F1 — compulsa integrada:** snapshots de RFQ, sourcing de proveedores, outreach, conciliación de
  ofertas y comparativa línea por línea. Hoy el cómputo se exporta y se compulsa afuera.
- **F2 — huecos y deducción completos:** el motor de reglas del §11 del PRD, las capas de anotación
  sobre el plano y el semáforo amarillo/rojo de deducciones. En F0 los huecos se detectan y se
  preguntan, pero no se auto-deducen.
- **F3 — negociación:** mandato de negociación, índice de precios y contador de ahorro.
- **F4 — multi-estudio SaaS:** billing, ingesta de DWG y panel de administración.

Tampoco están en F0 la doble pasada de verificación (RF-306), el Q&A sobre la obra (RF-106) ni el
versionado de documentación (RF-105).

## Testing

```bash
npm test        # 21 suites, 252 tests
npm run golden  # regresión de precisión
```

Los tests **nunca** usan red ni `ANTHROPIC_API_KEY`: el provider de análisis es siempre el mock con
fixtures. Los de integración corren sobre PGlite en memoria, uno por suite, sin persistir nada. Los
asserts pinean números exactos, no rangos. Ver [tests/CLAUDE.md](tests/CLAUDE.md).
