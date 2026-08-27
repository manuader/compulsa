# HANDOFF — Compulsa, estado actual

> **Banner:** **Todo el PRD está implementado y mergeado en `main`** (2026-08-26, commit 9550dac): F0 cómputo + gestión + F1 compulsa + F2 deducción + F3 negociación/índice/ahorro + F4 plataforma. Sobre eso, **mergeado en `main` el 2026-08-27 (commit d7d8b48)**, cambia el default del producto: **el sistema propone lo que sabe leer en vez de preguntarlo** — la escala declarada deja de bloquear, las planillas de carpinterías se extraen y se leen aunque no declaren escala, la consulta trae el valor propuesto con su fuente, y el plano se mira al lado de la pregunta. **1127/1127 tests en 71 suites (381 s con máquina quieta) · golden 2 casos 0,00 % · tsc limpio · e2e 7/7 en navegador.** Lo que falta ahí **no es código**: es la prueba con la obra real del usuario (SEG2580) — ver el handoff efímero más nuevo. Lo demás sigue bloqueado en credenciales (Supabase/Vercel, WhatsApp/voz/mail) y en obras reales para calibrar. Billing y DWG no se construyeron — decisión explícita, ver README «Lo que no está».

## 0. Cómo usar este documento

Si sos un agente que llega: leé **este archivo y el más nuevo de `handoffs/`**. Dos documentos. Con eso sabés dónde están las cosas.

| Dónde | Qué va | Vida |
|---|---|---|
| este general | lo que sigue siendo cierto: arquitectura, reglas, decisiones cerradas, trampas pagadas, §4 | permanente, acumula |
| `docs/SESSION-<fecha>-<tema>.md` | el detalle de una sesión | permanente, no se edita después |
| `handoffs/HANDOFF-<fecha>-<tema>.md` | estado al cierre: qué quedó abierto | efímero, gitignoreado |

Al terminar: (1) session doc, (2) handoff, (3) **actualizar este archivo** — nueva entrada en §4 más lo que corresponda en §5, §7 y §9. El paso 3 es el que se saltea y el que sostiene el sistema.

Si encontrás acá algo que ya no es cierto, **corregilo**. Un general creído y equivocado es peor que ninguno.

## 1. Qué es esto

Compulsa: el arquitecto sube la documentación de una obra y recibe el cómputo por rubros en planillas con trazabilidad total al plano, la lista de lo que la documentación no resuelve (clasificado), y las compulsas de precios lanzadas, conciliadas, negociadas y comparadas. Stack: Next.js 15 + TypeScript + Tailwind + Drizzle sobre Postgres (PGlite en dev/test), providers de IA detrás de interfaz (mock/Claude). Estado: **F0–F4 implementadas** salvo billing y DWG (decisión explícita); lo que falta es contacto con la realidad, §8.

## 2. Reglas del repo

Las operativas viven en `CLAUDE.md` (raíz) y en los CLAUDE.md por módulo (`src/db/`, `src/lib/computo/`, `src/lib/analysis/`, `src/app/`, `tests/`). Las tres que rompen todo si se ignoran: provenance obligatorio en datos generados, ningún dato inventado en silencio (taxonomía §11 del PRD), tests y build verdes antes de declarar nada terminado.

## 3. Arquitectura

- **Dominio puro** (`src/lib/computo`, `rubros`, `hallazgos`): sin I/O; testeable sin mocks. El pipeline y la UI dependen de él, nunca al revés.
- **Fronteras por interfaz:** análisis IA (`AnalysisProvider` mock/Claude en `src/lib/analysis`) y storage (`StorageAdapter` fs-local en `src/lib/storage`). El core no importa SDKs externos.
- **DB:** esquema Drizzle en español fiel al PRD §10, F0–F4. Cliente singleton PGlite↔Postgres por `DATABASE_URL` (`src/db/client.ts`). Migraciones automáticas al boot.
- **Pipeline** (`src/lib/pipeline`): jobs idempotentes por lámina con estados persistidos (pendiente → procesando → analizada | bloqueada_escala | error), exclusión mutua por claim condicional + mapa en vuelo, recompute tolerante a fallos que audita todo. Comparaciones jsonb SOLO con `igualJson` canónico (`pipeline/json.ts`).
- **UI:** App Router, Server Components + Server Actions. Núcleos DB-mutantes en `src/lib/*` (nunca exportados desde archivos `'use server'`); wrappers `*Action` con `requireObra`. Contratos internos públicos: `?highlight=<id>` (planilla/bandeja → visor) y `?rubro=` (export).

## 4. Qué cambió, sesión por sesión

### Sesión 2026-08-27 — Proponer en vez de bloquear (`feature/proponer`, código cerrado en d7e4e6b)

El uso con documentación real mostró que la bandeja se llenaba de consultas bloqueantes pidiendo datos que la IA podía extraer. Cuatro causas raíz verificadas, todas nuestras: **el prompt pedía `entidades: []` para las planillas** (la lámina donde viven las medidas se salteaba entera, y por eso la deducción `planilla_plano` nunca podía disparar con planos reales aunque el golden pasara con su mock); el `ObraContexto` **nunca llegaba al prompt** por el caché por `laminaId`; no existía "valor propuesto" en hallazgos, así que una medida leída con baja confianza se persistía y se tiraba; y `targetRef` apuntaba a un solo campo, así que responder el ancho hacía reaparecer una consulta por el alto.

Ahora: la escala **declarada** no bloquea (se computa como supuesto y se confirma con un click, sin re-analizar); las planillas de carpinterías extraen una entidad por fila; los hallazgos llevan `valor_propuesto_json` con fuente, confianza y origen; una consulta pide todas sus medidas juntas y se responde de una vez; una **búsqueda dirigida** relee las láminas candidatas con la lista de lo que falta en la mano y deja propuestas (nunca escribe atributos); y la bandeja embebe el visor, con el plano al lado de la pregunta. Además, instrucciones de extracción configurables por estudio, que entran al prompt.

Tres hallazgos de revisión que valieron la plata: el **CRITICAL** de que confirmar una consulta multi-campo con campos parciales la cerraba para siempre (los cerrados no se reabren ⇒ dato perdido, sin señal); un **TOCTOU** entre releer el hallazgo y escribir la propuesta; y una **trampa de ciclo de imports que rompe en runtime con `tsc` y unit tests verdes** (§7.14). Detalle y razones: [SESSION-2026-08-27-proponer-en-vez-de-bloquear.md](SESSION-2026-08-27-proponer-en-vez-de-bloquear.md).

**Revisión final de rama, antes del merge.** Cinco hallazgos más, y los dos graves son la misma clase de defecto: **una costura que la suite entera no podía ver**.

1. **El botón «Buscar los datos en la documentación» estaba muerto en runtime.** El envoltorio conservaba de un merge un `await import()` marcado `webpackIgnore`/`turbopackIgnore` hacia `@/lib/pipeline/busqueda`: el bundler dejaba el specifier crudo, Node no conoce el alias `@/`, y el `catch` traducía el `ERR_MODULE_NOT_FOUND` a "la búsqueda todavía no está disponible en esta versión". Build verde, suite verde, botón muerto una ola entera. Dos redes nuevas (§7.21): un test que invoca los `*Action` de verdad, y un chequeo de fuente — porque **el de runtime no lo agarra**: bajo `vitest` esos comentarios no significan nada.
2. **Una planilla de carpinterías sin escala impresa quedaba bloqueada, y con eso se apagaba toda la ola para esa obra.** Sin filas extraídas, sin deducción planilla↔plano, y excluida de la búsqueda dirigida (que exige `analizada`) — justo en la lámina donde están escritas las medidas del reclamo. Ahora una planilla se analiza aunque no declare escala, y sin abrir consulta de escala: en una tabla no se mide, se transcribe (§5.21).
   Lo que lo tapaba durante toda la ola: **los cuatro fixtures de planilla declaraban `escala: null` con `escalaConfiable: true`, una salida que el provider real no puede emitir** según su propio prompt. La suite validaba un rótulo imposible. Es exactamente §7.16 —la regla ya estaba escrita, y en la misma ola que la escribió volvió a pasar—: ver §7.22.
3. **Un texto, un negativo o un typo en un campo de medida cerraban la consulta como nota, para siempre.** `parsearCantidad` devuelve `null` también para los negativos, así que el chequeo `<= 0` solo atrapaba el cero: `-2`, `0,90 m` y `2,o5` caían al camino de texto y cerraban la respuesta entera sin escribir nada ni recomputar. Es el CRITICAL de los cierres parciales con otra cara. Hoy el downgrade a nota queda solo para las consultas donde **ningún** campo es de medida.
4. **La marca "buscado y no está" mentía dos veces:** cuando el cap truncaba la lectura (afirmaba sobre láminas que nadie abrió) y cuando quien había buscado era el mock sin API key (una obra subida antes de configurar la key quedaba envenenada para siempre). Ver §5.22.
5. **Tres mentiras de copy, una de ellas adentro del prompt** (la regla 4 de `SISTEMA` decía que sin verificar la escala la lámina queda bloqueada "y eso está bien", empujando al modelo en la dirección contraria a la decisión §5.15).

**El e2e en navegador se corrió: 7/7**, y encontró dos roturas que ninguna suite veía (fantasmas en el panel de deducciones, confirmación de escala en el expediente), las dos arregladas.

### Sesión 2026-08-26 (tarde) — F1 a F4: el resto del PRD
12 tareas (P1–P12) en olas paralelas: compulsa integrada (snapshot con hash, proveedores con import CSV, canal manual, conciliación línea por línea con score, repreguntas, conversaciones), deducción completa (5 reglas del §11, bandeja, memoria, planilla derivada), negociación con mandato, índice de precios, contador de ahorro, comparativa y adjudicación con orden de compra, y la plataforma (roles, invitaciones, config, checklists, notificaciones, auditoría). La revisión final de rama encontró tres defectos que ninguna revisión por tarea podía ver — `eliminarObra` destruía datos con obras que tenían compulsas, el loop de negociación nunca cerraba (el término de mejoras del ahorro era código muerto), y las sustituciones de spec eran invisibles en la pantalla de adjudicación — más una rotura introducida por el propio fix. Todo cerrado en dos rondas. Detalle: [SESSION-2026-08-26-f1-f4.md](SESSION-2026-08-26-f1-f4.md).

### Sesión 2026-08-26 (mañana) — UI de gestión + estreno del provider real con obra verdadera
Se agregó la gestión completa (eliminar documentos con recompute, archivar/editar/eliminar obras con type-to-confirm server-side, toggle archivadas, redirect auth, filenames de export distinguidos; núcleo en `src/lib/obras/gestion.ts`). En paralelo, el usuario activó su API key y subió una obra real de 25 láminas: los rótulos se leyeron bien y apareció el primer bug de producción — la gramática de structured outputs no garantiza largos de array y un bbox de 3 elementos tiraba la lámina entera; se arregló con schema de cable laxo + saneo por entidad (`sanearAnalisis`). Detalle: [SESSION-2026-08-26-gestion-y-provider-real.md](SESSION-2026-08-26-gestion-y-provider-real.md).

### Sesión 2026-08-25 — F0 completa: de repo vacío a producto funcional mergeado
Se instaló el sistema de handoffs, se escribió el plan de 11 tareas y se ejecutó entero por subagentes con revisión por tarea (5/11 con ronda de fixes) + revisión final de rama que encontró 3 defectos cross-tarea (auditorías fantasma por orden de claves jsonb, núcleos de bandeja expuestos en `'use server'`, bloqueantes rubro-null que no gateaban) — todos cerrados en una ola final. Cierre: 252/252 tests, golden 0,00 %, e2e 9/9 en navegador. Detalle y hallazgos: [SESSION-2026-08-25-f0-nucleo.md](SESSION-2026-08-25-f0-nucleo.md).

## 5. Decisiones no re-litigables

1. **PGlite + adaptadores locales en vez de Supabase real en F0** — sin Docker ni Supabase CLI en la máquina y MCP sin autenticar; PGlite da Postgres real con el MISMO esquema, y el cambio a Supabase es `DATABASE_URL` + adapter de storage + RLS, no una reescritura.
2. **Auth propio mínimo (scrypt + cookie httpOnly + tabla sesiones)** — Supabase Auth requiere el servicio real; la interfaz (`getSession`/`requireUser`/`requireObra`) es lo que la app consume.
3. **Provider mock determinístico como default y único en tests** — sin red ni API key en tests; la calidad del modelo real se mide aparte con el golden cuando haya key. Clave de fixture: `slug(documentoNombre)-p<página>` — **no hash de bytes**: pdf-lib re-serializa con fechas y el hash no es estable.
4. **Identificadores de dominio en español, fieles al PRD §10.**
5. **Rubros como datos** (`src/lib/rubros/`): agregar un rubro no toca el engine.
6. **El golden se deriva a mano, jamás corriendo el pipeline** — un esperado generado por lo que se testea se aprueba solo. Si el golden falla, se investiga qué lado está mal; no se "ajusta".
7. **Núcleos DB-mutantes nunca en archivos `'use server'`** — todo export de esos archivos es endpoint público HTTP. Patrón: núcleo en `src/lib/*`, wrapper `*Action` guardado.
8. **Worker de pdf.js = copia estática commiteada en `public/pdf.worker.min.mjs`** (hash verificado contra pdfjs-dist 4.10.38) — `new URL(..., import.meta.url)` no compila con pdfjs en `serverExternalPackages`.
9. **Borrar obra = archivar; el borrado físico existe solo sobre archivadas** con confirmación del nombre validada en el server, y purga todo incluida la auditoría de la obra dejando UNA fila `obra_eliminada` (obra_id null) — excepción documentada a la regla de soft-delete. La fila de rastro se escribe ANTES del barrido de storage (un EACCES no puede dejar una obra borrada sin rastro).
10. **El cable del LLM es laxo en lo numérico a propósito** (`zAnalisisLaminaCrudo` + `sanearAnalisis` en `src/lib/analysis/tipos.ts`): la gramática de structured outputs garantiza claves y enums pero no largos de array ni rangos; el contrato estricto se aplica por entidad (clamp de recuperables, descarte contado de inutilizables). El mock sigue estricto.
11. **Los canales de outreach son adapters honestos**: manual es el único activo; WhatsApp/voz/mail lanzan `CanalNoConfiguradoError` nombrando la env var que falta. Nunca un no-op silencioso ni UI que simule un envío que no ocurre.
12. **El snapshot RFQ es el contrato inmutable** (RF-701): hash sha256 sobre el JSON canónico del cómputo aprobado; recompulsar = versión N+1 explícita que cierra la anterior.
13. **Conciliación por Jaccard ≥ 0,5**, no coeficiente de solapamiento: con solapamiento "durlock" matcheaba "placa de yeso".
14. **El ahorro se calcula on-read** (adjudicaciones + cotizaciones + negociaciones), sin tabla que se desincronice; y **`exigirCompulsaEnJuego` guarda toda escritura** sobre una compulsa ya adjudicada.
15. **Una escala declarada-pero-no-verificada no bloquea; solo `escala: null` bloquea.** La lámina se analiza y computa con esa escala y la consulta pasa a `supuesto` no bloqueante con la declarada como propuesta. Razón: una escala que el rótulo dice y no se pudo verificar contra cotas es un *supuesto*, no una ausencia; cobrarle al arquitecto el precio de un dato faltante por un dato que está escrito era el bloqueo más caro del producto. Confirmar la **misma** escala no vuelve a llamar al modelo (la lámina ya tiene entidades); corregirla a otro valor sí, porque todo lo medido se midió con la anterior.
16. **`valorPropuesto.valores` es plural** (`Record<campo, valor>`) — una tarjeta lleva el ancho y el alto juntos. De ahí se sigue la regla dura: **una consulta se responde con TODAS sus medidas o no se responde**, y ni el campo que sí vino se escribe (§7.15).
17. **Confirmar un `*.baja_confianza.*` sube `entidades.confianza` a 1.** Sin eso el ítem nunca se emite: el gate de `computarRubro` mira la confianza de la **entidad**, no la del hallazgo, y confirmar no serviría de nada.
18. **La búsqueda dirigida SOLO propone; jamás escribe `atributos_json`** (P4). El dato entra a la entidad únicamente al confirmar, por la misma puerta que una respuesta escrita a mano. Y **la marca de "buscado sin resultado" caduca por huella de contenido, no por reloj**: el dato no aparece porque pase el tiempo, aparece porque el arquitecto sube el plano que lo tiene (sha256 sobre `id|tipo|estadoAnalisis|textoExtraido` de todas las láminas de la obra).
19. **Las planillas de carpinterías se extraen** (una entidad `abertura` por fila, `bbox` de la fila); carátulas, memorias e índices siguen con `entidades: []`. La regla nunca fue "no leas planillas", fue "no inventes", y una tabla de datos escritos no es una invención. `cantidad` de la planilla es informativa y **no computa**: la cantidad la pone la planta.
20. **Lo que el arquitecto cerró no se reabre** — tampoco la consulta de escala. `escala_confiable` es de una sola vía, así que una cerrada con la lámina sin confirmar significa que la descartó a propósito. Consecuencia: `hallazgo_reabierto` ya no lo emite nadie en el pipeline (la etiqueta de la pantalla de auditoría queda para las filas viejas).
21. **Una planilla no se mide: se lee.** Una lámina `tipo === 'planilla'` se analiza aunque no declare escala, y no se le abre consulta de escala. RF-201 existe para que nadie mida sobre una escala que no es; en una tabla no se mide, se transcribe, y sus números vienen con todas las letras y con el bbox de la fila. Bloquearla no protegía nada y apagaba la ola entera para esa obra: sin filas, sin deducción planilla↔plano y fuera de las candidatas de la búsqueda dirigida. Corolario en la planilla del cómputo: el badge «escala asumida» **saltea las planillas** — avisar que un número transcripto "se computó sin una escala verificada" es una advertencia falsa sobre el dato más confiable de la obra, y de las que enseñan a ignorar el badge.
22. **La marca de "buscado y no está" vale por documentación Y por provider, y solo la escribe una corrida que leyó todo.** Una corrida truncada por `MAX_LAMINAS_POR_BUSQUEDA` no marca nada (afirmaría algo sobre láminas que nadie abrió, con la huella de la obra entera, o sea sin caducidad), y una marca escrita por un provider no vale para otro (una obra subida antes de configurar `ANTHROPIC_API_KEY` la busca el mock, que sin fixture devuelve `[]`: sin esto quedaba envenenada para siempre).

## 6. Cómo verificar

```bash
npx vitest run --hookTimeout=120000 --testTimeout=120000   # 1127 tests / 71 suites (~6,5 min con máquina quieta)
npm run golden    # 2 casos: obra-demo (15 ítems) y obra-reforma (11), 0,00 %; exit 1 si algún rubro > 2 %
npm run build     # sin errores (2 warnings preexistentes de pdfjs en texto.ts)
npm run seed      # idempotente; demo@compulsa.ar / demo1234 + todo F1–F4 sembrado
npm run dev       # :3000 — NO correr build con dev levantado (comparten .next/)
```

Orden: test → golden → build. Con agentes/procesos pesados activos en la máquina los tests de integración (PGlite por test) dan timeouts falsos — verificar siempre con máquina quieta (§7.5, §7.9). Referencia de cuánto se estira: la corrida del 2026-08-27, con un agente hermano trabajando al lado, tardó **930 s**; la de la revisión final, con la máquina quieta, **381 s**. Verdes las dos.

**El `build` de la sesión del 2026-08-27 se corrió en un worktree detached y salió verde** — nunca en el checkout principal, donde vive el dev server del usuario (§7.6, §7.9). La revisión final de rama que vino después verificó `vitest` + `golden` + `tsc --noEmit` por el mismo motivo, y **no volvió a correr el build**: sus cambios son de `src/lib` y `src/app` con `tsc` limpio, pero si vas a mergear, corré el build en worktree y dejalo escrito acá.

## 7. Trampas en las que ya caímos

1. **No hay Docker ni Supabase CLI en esta máquina** (verificado 2026-08-25). No intentes `supabase start`.
2. **El hot-reload de Next duplica clientes de DB** — pasar siempre por el singleton `globalThis.__compulsaDb` de `src/db/client.ts`.
3. **Comparar jsonb con `JSON.stringify` crudo escribe ~50 auditorías fantasma por recompute**: Postgres reordena las claves. Usar `igualJson` de `src/lib/pipeline/json.ts`; hay test de regresión que lo protege.
4. **`pdfjs-dist@5.x` no importa en Node 21** (`process.getBuiltinModule` es Node ≥22.3) y arrastra `@napi-rs/canvas` (25 MB nativo) como optional dep. Está fijado 4.10.38 + override que bloquea el canvas; subir de major requiere subir Node primero.
5. **Corridas de verificación con otros agentes activos dan falsos rojos**: 7 tests "fallaron" por timeouts de contención de CPU y pasaban solos. Verificación final siempre con máquina quieta.
6. **`npm run build` con `dev` levantado corrompe `.next/`** — documentado en README.
7. **`npm run seed` necesita `process.exit()`**: la PGlite persistida deja vivo el event loop (falta `closeDb()` en client.ts).
8. **La gramática de structured outputs NO valida largos de array ni rangos numéricos**: un `bbox` de 3 elementos pasó la generación con documentación real y el schema estricto rechazaba la lámina completa. Por eso existe la decisión §5.10 — no "simplificar" volviendo al schema estricto en `zodOutputFormat`.
9. **Con la máquina cargada la suite necesita `npx vitest run --hookTimeout=120000 --testTimeout=120000`**: sin los flags caen suites enteras por `Hook timed out` en `createTestDb` (cero asserts rotos). La suite completa tarda ~5,5 min sola y **no tolera otra corriendo al lado**. Para build con el dev server vivo: worktree detached (`git worktree add --detach .worktrees/buildcheck <sha>`), nunca en el checkout principal.
10. **Next valida exports que `tsc` no ve**: un `'use server'` solo exporta funciones async; un `route.ts` solo verbos HTTP y opciones de segmento. Cualquier otra cosa compila, pasa los tests y **rompe el build**. Lo guarda `tests/unit/exports-de-next.test.ts`.
11. **`max: 1` en el pool de Postgres es load-bearing**, no una decisión de performance: es lo que hoy cierra la carrera de adjudicación, el read-modify-write del índice de precios y la invariante del último titular. Subir el pool exige antes los `FOR UPDATE` documentados.
12. **La cadena de borrado de `eliminarObra` se olvida sola.** Dos veces ya: `recomputos` y las siete tablas de compulsa. Toda tabla nueva que cuelgue de una obra va agregada ahí, o la purga explota a mitad (sin transacción) y destruye datos.
13. **Nunca `pkill -f "next dev"`**: mata también el dev server del usuario. Matá por PID.
14. **Un ciclo de imports puede romper solo en runtime, con `tsc --noEmit` limpio y los unit tests verdes.** `rubros/aberturas.ts` importando `normalizarTag` desde `deduccion/reglas/planilla-plano.ts` metía `deduccion/motor.ts` en el grafo del motor de cómputo; `motor.ts` arma su tabla `IMPLEMENTACIONES` en el cuerpo del módulo y con el ciclo el módulo de las reglas quedaba a medio evaluar: **`TypeError: IMPLEMENTACIONES[regla] is not a function`**, visible recién en un test de integración. Por eso `normalizarTag` vive en `src/lib/computo/tags.ts` (hoja, sin imports) y se re-exporta desde la regla. No lo "ordenes" de vuelta.
15. **Cerrar un hallazgo con parte de sus campos pierde el dato para siempre y sin señal.** `recomputarObra` no reabre un hallazgo cerrado (regla 3 de `recomputar.ts`): responder el ancho de una consulta que pide ancho **y** alto la cerraba, y el alto quedaba sin ítem, sin consulta que lo volviera a pedir y sin nada en la auditoría. Es el mismo agujero que un `0` con otra cara. Hoy lo tapan `responderHallazgo` (los dos caminos, también el `valor` suelto) y `confirmarLote`, que rechazan el payload incompleto **sin escribir nada**.
16. **Un fixture del mock puede tapar que una regla no dispara nunca en producción.** El golden 2 pasaba a 0,00 % con la deducción `planilla_plano` verde mientras el prompt real pedía `entidades: []` para las planillas — el fixture del mock traía las entidades que el modelo nunca devolvía. Un camino que solo se ejercita con el provider real no tiene red: verificalo con la API, no con el golden. **Y ver §7.22: esta regla estaba escrita, y en la misma ola que la escribió volvió a pasar.**
17. **Releer una fila y después escribirla es una ventana abierta.** La propuesta de la búsqueda se escribía sobre hallazgos que el arquitecto acababa de cerrar desde la bandeja. La condición va **en el `WHERE`** (`AND estado = 'abierto'`), mismo patrón que la invariante del último titular; cero filas es un resultado, no un error. Vale para toda escritura del pipeline sobre algo que la UI puede estar tocando.
18. **jsonb tampoco conserva el orden de escritura de las claves** (ordena por largo y después alfabéticamente). Ya mordió con las auditorías fantasma (§7.3) y vuelve a morder en el orden de los campos de una propuesta de lectura: `campos` sale `['altoM','anchoM']`, no `['anchoM','altoM']`. Cualquier pin sobre ese orden se puede romper por una razón ajena a la lógica.
19. **Un byte NUL literal en un `.ts` lo vuelve invisible para `grep` y `rg`, en silencio.** Ya pasó en F1–F4 y **volvió a pasar** en `src/lib/pipeline/busqueda.ts`, que tenía un `\x00` crudo como separador en el `hash.update(...)` de `huellaDocumentacion`. `file` lo reporta como `data`, y tanto `grep -rn` como `rg` lo saltan **sin decir nada** — buscar `huellaDocumentacion` en `src/` devolvía solo el comentario de `domain.ts` que apunta a ella, y la definición no aparecía. `git grep` sí lo encontraba, así que el archivo estaba bien versionado; el problema era todo agente que buscara con las otras dos. **Arreglado en c82c346**: las filas entran serializadas con `JSON.stringify`, que escapa comillas y saltos de línea y no necesita ningún separador binario. El fuente quedó ASCII y el archivo vuelve a aparecer en las búsquedas.
20. **`Overlay` hace `scrollIntoView` en un `useEffect([destacados])`:** un array nuevo por render scrollea de más cada vez que la pantalla se redibuja (tipear en otra tarjeta, tildar un checkbox, que vuelva una Server Action). La selección entera vive en el estado y el vacío es la constante de módulo `SIN_DESTACADOS` — nunca un `?? []` inline.
21. **Un `import()` marcado `webpackIgnore`/`turbopackIgnore` hacia un alias `@/` está roto en runtime, siempre, y no hay test de runtime que lo vea.** Esos comentarios le dicen al bundler que deje el specifier crudo para que lo resuelva Node — y Node no conoce el alias, que lo inventan `tsconfig.json` y el bundler: `ERR_MODULE_NOT_FOUND` en cada llamada. Le pasó a `buscarEnDocumentacionAction`, que además tenía un `catch` traduciéndolo a un cartel en castellano: el botón de la bandeja estuvo muerto una ola entera con el build y la suite en verde. **Bajo `vitest` esos comentarios no significan nada** —vite-node resuelve el alias igual y el import anda—, así que el bug solo existe con el bundler de por medio, o sea únicamente en la app de verdad; se verificó corriendo el test de runtime contra el código roto y pasaba. Lo guarda ahora un chequeo de **fuente** en `tests/unit/exports-de-next.test.ts`: en `src/` no puede haber ningún `import()` ignorado.
    Corolario más general: **el patrón "envoltorio sin lógica" no tenía una sola prueba**. Un `'use server'` es puro cable —sesión, obra del estudio, núcleo, `revalidatePath`— y precisamente por no tener lógica nadie lo ejercitaba. Ahora `tests/integration/bandeja-acciones.test.ts` llama los `*Action` de verdad; si el cable se corta, se ve.
22. **La regla del fixture imposible (§7.16) estaba escrita y volvió a pasar en la misma ola que la escribió.** Los cuatro fixtures de planilla declaraban `escala: null` con `escalaConfiable: true`. El prompt real manda `escalaConfiable: true` **solo** tras verificar contra ≥ 2 cotas: una planilla no imprime escala, así que el provider real **no puede** emitir ese rótulo. La suite entera validaba una salida imposible, y con eso tapaba que en producción toda planilla quedaba `bloqueada_escala` — sin filas extraídas, sin deducción y fuera de la búsqueda dirigida. La pregunta de §7.16 ("¿el provider real puede producir *esto*?") hay que hacérsela **campo por campo del fixture**, no sobre el fixture en bloque, y hay que hacérsela de nuevo cada vez que cambia el prompt: un fixture no se vuelve mentira solo el día que se escribe, se vuelve mentira el día que el prompt cambia debajo.

## 8. Qué falta

**El PRD está completo; lo que falta no es alcance, es contacto con la realidad.**

- **Cerrar `feature/proponer`: falta la prueba con la obra real (SEG2580).** Es lo más urgente y no es opcional: la extracción de planillas —la causa raíz principal— **no tiene ni puede tener red de tests** (el prompt solo se ejercita contra la API real), y el criterio de éxito es que las medidas de FP01/FP02 lleguen **propuestas, no preguntadas**. El e2e en navegador **ya se corrió, 7/7**, y encontró dos roturas que la suite no veía. Los flecos menores diferidos están en el handoff efímero más nuevo, ítem por ítem.
- **Probarlo con una obra y proveedores reales** — el otro paso de mayor valor. Ahí se calibran el matching de conciliación (Jaccard penaliza descripciones cortas del proveedor) y los textos del gremio.
- **Deuda aceptada por la revisión final** (con razones, al final de [SESSION-2026-08-26-f1-f4.md](SESSION-2026-08-26-f1-f4.md)): `conciliarCotizacion` bajo `exigirCompulsaEnJuego` (riesgo residual nombrado), unificar las 4 copias de `requireRolCore`, mover los cores restantes fuera de `'use server'`, transacción en `adjudicarCompulsa`, doble conteo residual planta↔corte en tabique/muro/ambiente. De F0 queda `closeDb()`.
  El caché de `claude.ts` que pisaba el `ObraContexto` **está cerrado** (2026-08-27: `leerRotulo(lamina, ctx?)`), y de paso la fila de `analisis_llm` ganó `obraId`. **Paralelizar `procesarDocumento` sigue abierto y ahora pesa más:** además de secuencial, el request de upload arrastra hasta 8 llamadas de búsqueda dirigida al final. Sacar la búsqueda del request y paralelizar el pipeline son el mismo follow-up.
- **Bloqueado en credenciales del dueño:** Supabase/Vercel (deploy + RLS), WhatsApp/voz/mail (los adapters están escritos, faltan las llaves), obras reales con cómputo manual para un golden real, respuestas del §18 del PRD.
- **No construido por decisión explícita:** billing (Mercado Pago) y DWG/DXF — requieren cuentas y servicios inexistentes acá; ver README «Lo que no está».

## 9. Mapa de documentos

| Doc | Responde |
|---|---|
| **este** | punto de entrada, estado, arquitectura |
| `doc/PRD.md` | el producto completo: módulos, RFs, modelo de datos, roadmap |
| `doc/IDEA.md` | el pitch / narrativa de producto |
| `docs/superpowers/plans/2026-08-25-compulsa-f0.md` | el plan de F0 tarea por tarea (ejecutado) |
| `docs/superpowers/plans/2026-08-26-compulsa-f1-f4.md` | el plan de F1–F4 con todas las fórmulas pinneadas (ejecutado) |
| [SESSION-2026-08-27-proponer-en-vez-de-bloquear.md](SESSION-2026-08-27-proponer-en-vez-de-bloquear.md) | por qué el sistema preguntaba lo que sabía leer: las 4 causas raíz, los hallazgos de revisión y las decisiones del rediseño |
| [SESSION-2026-08-26-f1-f4.md](SESSION-2026-08-26-f1-f4.md) | cómo se construyó el resto del PRD, los 3 bugs de rama entera y la deuda aceptada |
| [SESSION-2026-08-26-gestion-y-provider-real.md](SESSION-2026-08-26-gestion-y-provider-real.md) | gestión de obras/documentos y el estreno del provider real |
| [SESSION-2026-08-25-f0-nucleo.md](SESSION-2026-08-25-f0-nucleo.md) | cómo se construyó F0, los bugs que valieron la plata, la deuda aceptada |
| `CLAUDE.md` + CLAUDE.md por módulo | reglas operativas de cada área |
| `README.md` | setup, comandos, arquitectura para humanos |
