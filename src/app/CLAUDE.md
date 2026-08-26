# CLAUDE.md — src/app (workspace UI + API)

El workspace del arquitecto (PRD §8). Ocho pantallas previstas; en F0 existen: tablero de obra, expediente, visor de láminas, planilla de cómputo y bandeja de consultas.

## Reglas de UI

1. **es-AR, voseo, terminología del rubro** ("Subí la documentación", "Aprobar rubro", durlock, premarco, DVH). Nada de spanglish ni de "usted".
2. **Server Components por defecto;** `"use client"` solo donde hay interactividad real (visor, grilla editable, formularios). Data fetching en el server con `getDb()`; mutaciones vía Server Actions o route handlers de `src/app/api/`.
3. **Toda página de obra valida pertenencia:** helper `requireObra(obraId)` — sesión válida + obra del estudio del usuario; si no, `notFound()`. Nunca consultes una obra por id sin pasar por ahí (aislamiento RNF-4).
4. **El visor y la planilla están acoplados por contrato, no por imports:** la fila de la planilla linkea a `/obras/[obraId]/laminas/[laminaId]?highlight=<bboxId>`; el visor lee `highlight` y resalta el bbox (RF-303: < 2 s). Ese query param es API pública interna — no lo renombres sin buscar sus usos.
5. **Estados visibles:** una lámina siempre muestra su `estado_analisis` (pendiente / procesando / analizada / bloqueada por escala / error) y una lámina bloqueada explica qué necesita (medida de referencia). Nada de spinners eternos sin explicación.
6. **Acciones destructivas o de aprobación piden confirmación** (aprobar rubro, descartar hallazgo) y quedan en `auditoria`.
7. Formularios con validación Zod compartida entre cliente y server (`src/types/domain.ts` exporta los schemas). El server NUNCA confía en el payload.
8. Tailwind directo, sin librería de componentes externa; primitivas propias en `src/components/ui/` (Button, Input, Select, Badge, Card, Table, Dialog). Reusalas — no dupliques estilos inline de botones.

## Mapa de rutas

```
/login, /register            auth
/obras                       lista + crear
/obras/[obraId]              tablero (estado por rubro, huecos abiertos, accesos)
/obras/[obraId]/expediente   documentos y láminas (upload, clasificación, estados)
/obras/[obraId]/laminas/[laminaId]  visor (pdf.js + overlay SVG de entidades/hallazgos)
/obras/[obraId]/computo      planilla por rubro (grilla editable, aprobar rubro, export)
/obras/[obraId]/bandeja      bandeja de consultas (hallazgos con acciones de un click)
/obras/[obraId]/deducciones  bandeja de deducciones (propuestas del motor §11, validar/rechazar)
/api/...                     route handlers (upload, pipeline, export, memoria, planilla derivada)
```
