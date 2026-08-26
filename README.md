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

Con el cómputo aprobado arranca la otra mitad: **la compulsa**. El sistema congela lo aprobado en
un snapshot con hash, arma el pedido de cotización con las condiciones del §13 del PRD (IVA
discriminado, mano de obra y materiales separados, validez, plazo) y los recortes de plano de cada
ítem, y lo deja listo para mandar. Lo que contesta el proveedor se pega tal cual: el sistema lo lee,
lo concilia línea por línea contra el pedido —exacto, parcial, sustituto, no cotizado, extra—, le
pone un score de fidelidad y escribe solo las repreguntas de lo que falta. Después la comparativa
pone todo en un cuadro, lo rankea por precio, fidelidad y plazo, lo compara contra el índice de
precios del propio estudio, y de adjudicar sale la orden de compra en PDF y el contador de ahorro.

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

Entrás y encontrás **dos obras**, una para cada mitad del producto:

- **«Casa Belgrano — reforma demo»** — la del cómputo: tres documentos subidos, cinco láminas
  (cuatro analizadas y una bloqueada por falta de escala), quince ítems en los cuatro rubros, un
  ítem corregido a mano y la bandeja con una consulta respondida y otra abierta.
- **«Casa Reforma — demo»** — la de la compulsa: un muro a demoler, un tabique existente que no
  computa y una ventana sin acotar en la planta que la planilla de carpinterías sí acota. De ahí
  salen tres deducciones —una validada, dos esperando tu visto bueno—. Sobre su rubro `seco`
  aprobado corre la compulsa: cuatro proveedores en la agenda (uno con opt-out), dos contactados,
  dos presupuestos conciliados —uno con una sustitución de especificación y un ítem sin cotizar,
  que deja una repregunta en borrador—, el índice de precios del mes poblado y una ronda de
  negociación propuesta.

Además queda un **código de invitación de colaborador vigente** (el seed lo imprime al terminar):
con ese código, desde `/register`, das de alta a un segundo usuario y ves la diferencia de roles en
pantalla. Alcanza para recorrer el producto entero sin cargar un solo archivo.

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
npm test             # vitest (unit + integration) — 925 tests, sin red
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
- **Adaptadores** (`src/lib/analysis`, `src/lib/storage`, `src/lib/outreach`, `src/db`): la IA, los
  archivos y los canales de contacto entran por interfaz, con implementación mock/local y real
  (Claude API / Supabase Storage). El core no importa SDKs de servicios externos. Drizzle sobre
  PGlite o Postgres según `DATABASE_URL`.
- **Pipeline** (`src/lib/pdf`, `src/lib/pipeline`): sube el documento, lo separa en láminas de una
  página, extrae texto, pide rótulo y entidades al provider, guarda con provenance y recomputa la
  obra. Idempotente y con estados visibles por lámina; toda escritura queda en `auditoria`.
- **UI** (`src/app`, `src/components`): Server Components por defecto, `"use client"` solo donde
  hay interactividad real (visor, grilla editable, formularios). Las pantallas de la obra —tablero,
  expediente, visor, planilla, bandeja, deducciones, compulsas, conversaciones, comparativa— más
  proveedores y estudio, y las route handlers de upload, export y reportes. El mapa completo de
  rutas está en [src/app/CLAUDE.md](src/app/CLAUDE.md).

## Estado: F0–F4 sin billing ni DWG

Lo que hay hoy, punta a punta.

### El cómputo (F0)

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
- **Doble pasada de verificación (RF-306):** «Verificar cómputo» relee las láminas, compara contra
  la planilla y abre una consulta no bloqueante por cada desvío mayor al 5%, citando los dos
  valores.
- **Preguntale al expediente (RF-106):** preguntas en castellano sobre la obra, respondidas **solo**
  con lo que dicen las láminas y citando en cuáles. Si no está, dice que no está.
- **Resumen ejecutivo y «Qué cambió»:** el alcance de la obra en una frase y el historial de
  recomputos con cuántos ítems se movieron en cada uno.
- Export XLSX por rubro y consolidado, con las láminas fuente de cada ítem.
- Auditoría de toda escritura de agente y del usuario, con actor y diff, paginada por estudio.
- Harness de precisión (`npm run golden`) sobre un golden set: error ≤ 2% por rubro (RNF-1).

### La compulsa (F1)

- **Agenda de proveedores** por rubro y zona, con opt-in de WhatsApp y opt-out registrado, alta a
  mano e **importación desde CSV** con preview: antes de guardar nada se ve qué entra, qué línea
  tiene un problema y qué proveedor se va a fusionar con uno que ya está.
- **Snapshot con hash (RF-701):** lanzar una compulsa congela los ítems del rubro aprobado y sus
  condiciones en un sha256. Si después se edita la planilla, volver a pedir precios crea una
  **versión nueva** y cierra la anterior: las dos quedan, con lo que efectivamente se pidió en cada
  una.
- **Texto del pedido** con las condiciones del §13 (IVA discriminado, mano de obra y materiales
  separados, validez, plazo) y un **recorte de plano en PDF por ítem**.
- **Canal manual** (el único activo): el sistema escribe, vos copiás y mandás por donde ya hablás
  con cada proveedor, y marcás enviado. Nada se da por enviado sin que alguien lo mande.
- **Conciliación línea por línea (RF-902/903):** se pega el presupuesto tal como llegó y cada línea
  se clasifica en `exacto`, `parcial`, `sustituto`, `no cotizado` o `extra`, con un **score de
  fidelidad**. Una sustitución de especificación levanta bandera roja; lo no cotizado genera la
  **repregunta** ya redactada.
- **Conversaciones**: todo el hilo con cada proveedor, con los mensajes entrantes registrados tal
  cual los escribió, y aviso a los siete días de silencio.
- **Comparativa (RF-1101):** cuadro de ítems × proveedores con la primera columna fija, ranking
  multicriterio con el desglose a la vista, validez de cada oferta y export XLSX.
- **Adjudicación:** confirmación con el resumen de lo que se firma, **orden de compra en PDF** y
  cierre de los contactos que quedaban en juego.

### Deducción y huecos (F2)

- **Motor de reglas del §11 del PRD**: `planilla_plano`, `planta_corte`, `continuidad`,
  `idem_tipologia` y `cierre_cotas`. Cada deducción llega con su regla, sus fuentes (dos láminas
  como mínimo), su valor y su confianza; por debajo de 0,7 no se propone, se pregunta.
- **Nada se escribe sin visto bueno**: la bandeja de deducciones propone, y validar es lo que
  escribe el dato en el elemento y hace que el ítem salga marcado **deducido** con las fuentes de
  la deducción. Rechazar lo devuelve a la bandeja de consultas como dato faltante.
- Nada estructural ni de seguridad se auto-propone (RF-506).
- **Memoria de deducciones** en Markdown y **planilla de carpinterías derivada** en XLSX,
  descargables.

### Negociación, índice y ahorro (F3)

- **Mandato de negociación** por estudio: objetivo de mejora, palancas habilitadas y dos rondas como
  máximo (RF-1001). El motor propone la contraoferta solo si el número da, usa **solo** las palancas
  del mandato, y ante una sustitución de especificación **no negocia**: escala al usuario.
- **Índice de precios propio del estudio** (RF-1103): cada línea conciliada alimenta
  `(ítem, zona, mes)` y la comparativa marca cada precio unitario contra el p50/p75 — solo con tres
  muestras o más, porque con menos no hay mercado que comparar.
- **Contador de ahorro** (RF-1104) por compulsa, por obra y por estudio: mediana de las ofertas
  menos lo adjudicado, más las mejoras de negociación aceptadas. Puede dar negativo, y se muestra
  negativo.

### Multi-usuario (F4 parcial)

- **Tres roles** (RF-1201): `titular` hace todo; `colaborador` todo menos aprobar rubros, lanzar
  compulsas, adjudicar, eliminar obras y gestionar usuarios; `lectura` no muta nada. El permiso lo
  exigen los núcleos, no la pantalla: esconder un botón es cortesía.
- **Invitaciones por código** con rol y vencimiento, alta y baja lógica de usuarios.
- **Configuración del estudio**: desperdicio por rubro (guardar recalcula las obras activas),
  condiciones por defecto del pedido, mandato, pesos del ranking, dólar MEP de referencia y
  **checklists por rubro** (qué se chequea y qué frena la aprobación).
- **Notificaciones** con campanita y deduplicación por clave: deducciones esperando, proveedor que
  no contesta, compulsa adjudicada, alguien que se sumó al estudio.

### Canales de contacto: uno activo, tres adaptadores

El **canal manual es el único que manda mensajes**, y es una decisión de producto antes que una
limitación técnica: el §13 del PRD prohíbe el contacto frío por WhatsApp, y el canal manual deja la
decisión de mandar —y por dónde— en manos de una persona, con el consentimiento del proveedor a la
vista.

WhatsApp, voz y mail existen como **adaptadores detrás de la misma interfaz** (`src/lib/outreach/`).
Sin credenciales fallan al construirse con un error que nombra la variable que falta, nunca con un
envío silencioso que no ocurrió:

| Canal | Variable | Estado |
|---|---|---|
| manual | — | **activo** |
| whatsapp | `WHATSAPP_TOKEN` | adaptador; se activa con credenciales **y** con su implementación |
| voz | `RETELL_API_KEY` | ídem |
| email | `SMTP_URL` | ídem |

Setear la variable **no alcanza**: falta escribir el adaptador de verdad. Están documentadas en
`.env.example` porque son lo que el error de configuración nombra y lo primero que va a hacer falta
el día que se implementen.

### Lo que **no** está

- **Billing (Mercado Pago).** No se construyó ni se muestra en la UI. Es lo primero que hay que
  hacer para cobrar, y hoy no hay nada: ni plan, ni límite, ni pantalla.
- **Ingesta de DWG/DXF y export DXF.** El pipeline lee PDF y nada más. Autodesk Platform Services
  quedó afuera.
- **RLS en Supabase.** El aislamiento entre estudios está en la aplicación —helper `requireObra`,
  actor con `estudioId` en cada core— y hay tests que lo prueban punta a punta, pero las políticas
  de fila en Postgres se agregan en el deploy (ver `src/db/CLAUDE.md`).
- **Envío real por WhatsApp, voz o mail**, por lo de arriba.

## Testing

```bash
npm test        # 59 suites, 925 tests
npm run golden  # regresión de precisión sobre el golden set (2 obras)
```

Los tests **nunca** usan red ni `ANTHROPIC_API_KEY`: los providers de análisis, de presupuesto y de
Q&A son siempre el mock con fixtures. Los de integración corren sobre PGlite en memoria, uno por
suite, sin persistir nada. Los asserts pinean números exactos, no rangos. Ver
[tests/CLAUDE.md](tests/CLAUDE.md).

La suite completa tarda unos minutos: cada suite de integración levanta su propia PGlite. Si la
máquina está cargada, `npx vitest run --hookTimeout=120000 --testTimeout=120000`.
