# CLAUDE.md — Compulsa

Plataforma de análisis documental, cómputo y compulsa de obra para estudios de arquitectura argentinos. El documento rector del producto es [doc/PRD.md](doc/PRD.md) (v2.0); el pitch está en [doc/IDEA.md](doc/IDEA.md).

## Protocolo de arranque y cierre (obligatorio)

Antes de empezar, leé `docs/HANDOFF.md` y el archivo más nuevo de `handoffs/`. Dos archivos: con eso sabés dónde está parado el proyecto.

Al terminar una sesión de trabajo: (1) escribí tu `docs/SESSION-<fecha>-<tema>.md`, (2) dejá tu `handoffs/HANDOFF-<fecha>-<tema>.md`, (3) **actualizá `docs/HANDOFF.md`** — el paso 3 es el que se saltea y el que sostiene todo el sistema.

## Qué es esto (una línea por fase)

- **F0 (hecho):** núcleo de cómputo — crear obra, subir PDFs, pipeline de análisis, planilla con provenance, bandeja de consultas, export XLSX, doble pasada (RF-306), Q&A del expediente (RF-106), resumen ejecutivo.
- **F1 (hecho):** compulsa integrada — agenda de proveedores con import CSV, snapshot con hash (RF-701), texto del pedido con recortes, canal manual, conciliación línea por línea con score, repreguntas, conversaciones, comparativa y adjudicación con orden de compra.
- **F2 (hecho):** huecos y deducción — motor de reglas del §11, bandeja de deducciones con fuentes y confianza, memoria en Markdown y planilla de carpinterías derivada.
- **F3 (hecho):** negociación con mandato y dos rondas, índice de precios del estudio y contador de ahorro por compulsa, obra y estudio.
- **F4 (parcial):** roles, invitaciones, configuración del estudio, checklists, auditoría y notificaciones. **Billing (Mercado Pago) y DWG/DXF no se construyeron**; WhatsApp, voz y mail son adaptadores que fallan con un error de configuración honesto (`src/lib/outreach/stubs.ts`). Ver README §«Lo que no está».

## Stack

- **Next.js 15 (App Router) + React 19 + TypeScript estricto + Tailwind CSS.**
- **Drizzle ORM** sobre Postgres. En desarrollo y tests corre **PGlite** (Postgres embebido, sin Docker); en producción, Postgres real / Supabase vía `DATABASE_URL`. El esquema es 100% portable a Supabase (RLS se agrega en deploy, ver `src/db/CLAUDE.md`).
- **Adaptadores, no dependencias directas:** storage (`src/lib/storage`), análisis IA (`src/lib/analysis`) y canales de outreach (`src/lib/outreach`) son interfaces con implementación local/mock y real (Supabase Storage / Claude API / WhatsApp, voz y mail). El core no importa SDKs de servicios externos. Un servicio sin credenciales **falla con un error que nombra la variable que falta**, nunca con un no-op silencioso.
- Tests con **Vitest**. PDF con **pdf-lib** (split) y **pdfjs-dist** (texto/render). XLSX con **exceljs**.

## Comandos

```bash
npm run dev          # dev server (PGlite local, migra al boot)
npm run build        # build de producción
npm test             # vitest (unit + integration)
npm run golden       # harness de regresión de precisión contra el golden set
npm run seed         # datos de demo (estudio + usuario demo@compulsa.ar / demo1234 + obra ejemplo)
npm run db:generate  # drizzle-kit generate (tras tocar src/db/schema.ts)
```

## Reglas del repo

1. **Idioma:** UI y textos de agentes en **es-AR** (vos, terminología local: durlock, corralón, DVH, premarco). Identificadores de dominio en español (siguen al PRD §10: `obras`, `laminas`, `computo_items`, `hallazgos`); código de infraestructura en inglés.
2. **Provenance no negociable (P1):** ningún dato generado por el sistema entra a la base sin `fuentes_json` (lámina + bbox normalizado) u origen declarado. Un `computo_item` sin fuente es un bug, no un detalle.
3. **Deducir, no inventar (P4):** el sistema jamás rellena un dato en silencio. Lo que no es explícito ni deducible con fuentes es un hallazgo en la bandeja. Nada estructural/de seguridad se auto-propone (RF-506).
4. **Toda escritura de agente se audita:** usar `registrarAuditoria()` (`src/lib/audit.ts`) en cada mutación hecha por pipeline o agentes, con actor y diff.
5. **TDD:** el dominio puro (`src/lib/computo`, `src/lib/rubros`, `src/lib/hallazgos`) se desarrolla test-first. Nada se declara terminado sin `npm test` y `npm run build` verdes, con la salida a la vista.
6. **No tocar los originales:** los archivos subidos son inmutables; derivados (láminas separadas, anotaciones) son archivos/registros nuevos.
7. **CLAUDE.md por módulo:** cada área con reglas propias tiene su CLAUDE.md (`src/db/`, `src/lib/computo/`, `src/lib/analysis/`, `src/app/`, `tests/`). Leé el del área que vas a tocar antes de editar.
8. Secretos solo por variables de entorno (`.env.local`, nunca commiteado). `ANTHROPIC_API_KEY` habilita el provider real de análisis; sin la key, el sistema usa el provider mock determinístico (los tests SIEMPRE usan mock). Los canales de outreach declaran las suyas en `src/lib/outreach/stubs.ts` y están documentadas en `.env.example`.
9. **Next decide qué se exporta en dos clases de archivo, y no es negociable:** un `'use server'` solo exporta funciones `async`; un `src/app/api/**/route.ts` solo exporta verbos HTTP y opciones de segmento (`runtime`, `dynamic`…). Los tipos y las interfaces sí, que se borran al compilar. Cualquier otra cosa compila con `tsc`, pasa la suite y **rompe el build**; lo guarda `tests/unit/exports-de-next.test.ts`.

## Mapa del código

### Cómputo (F0)

| Área | Qué es |
|---|---|
| `src/db/` | esquema Drizzle, cliente (PGlite/Postgres), migraciones |
| `src/lib/computo/` | motor de cómputo puro: unidades, desperdicio, presentación comercial, sanity checks |
| `src/lib/rubros/` | plantillas y checklists por rubro (aberturas, seco, pintura, gruesa) + `overrides.ts`, que aplica la config del estudio a las plantillas |
| `src/lib/hallazgos/` | taxonomía de huecos (§11 PRD) y gate de aprobación |
| `src/lib/analysis/` | providers de IA (mock/Claude): rótulos y entidades (`mock.ts`, `claude.ts`), presupuestos (`presupuesto-*.ts`) y Q&A (`qa-*.ts`) — los tres con fixture y caída a heurística determinística |
| `src/lib/pdf/` | split de PDFs, extracción de texto, raster |
| `src/lib/pipeline/` | orquestación por lámina/obra: `procesar.ts` (upload y análisis), `recomputar.ts` (recompute idempotente + deducciones), `verificacion.ts` (doble pasada RF-306), `resumen.ts` (resumen ejecutivo), `claves.ts` (namespaces de hallazgos) |
| `src/lib/export/` | export XLSX del cómputo y planilla de carpinterías derivada |
| `src/lib/bandeja/`, `src/lib/obras/` | resolución de consultas; alta, edición y archivado de obras |
| `src/lib/auth/`, `src/lib/storage/`, `src/lib/audit.ts` | sesiones, archivos, auditoría |

### Compulsa, deducción y plataforma (F1–F4)

| Área | Qué es |
|---|---|
| `src/lib/compulsa/` | el corazón de F1: `snapshot.ts` (hash RF-701), `texto-rfq.ts` (el pedido, §13), `recortes.ts` (un PDF por ítem), `flujo.ts` (lanzar, enviar, registrar cotización, conciliar, negociar), `conciliacion.ts` (matching determinístico línea a línea), `repreguntas.ts`, `comparativa.ts` (cuadro, ranking, benchmark), `adjudicar.ts` y `orden-compra.ts` |
| `src/lib/proveedores/` | agenda (`gestion.ts`), shortlist por rubro y zona, import CSV con preview y errores por línea |
| `src/lib/outreach/` | el canal: `canal.ts` (interfaz + composición del cuerpo con adjuntos), `manual.ts` (**el único activo**), `stubs.ts` (WhatsApp/voz/mail con error de configuración honesto), `threads.ts` (lectura de hilos y banderas) |
| `src/lib/deduccion/` | motor del §11: `motor.ts` + `reglas/*.ts` (planilla↔plano, planta↔corte, continuidad, ídem tipología, cierre de cotas), `persistencia.ts` (validar/rechazar) y `memoria.ts` (el .md descargable) |
| `src/lib/indice/` | percentiles nearest-rank del índice de precios del estudio (p25/p50/p75 con `n`) |
| `src/lib/negociacion/` | el motor de contraofertas: cuándo procede, qué palancas usa y cuándo escala al usuario |
| `src/lib/ahorro/` | el contador de ahorro (RF-1104), puro |
| `src/lib/plataforma/` | `roles.ts` (matriz RF-1201 y `requireAccion`), `usuarios.ts` (invitaciones, altas y bajas), `config-estudio.ts` (merge por sección), `checklists.ts`, `notificaciones.ts` (con dedup por clave) |
| `src/app/` | pantallas del workspace + API routes — mapa completo en `src/app/CLAUDE.md` |
| `tests/` | unit, integration, fixtures y golden set |
