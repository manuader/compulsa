# CLAUDE.md — src/app (workspace UI + API)

El workspace del arquitecto (PRD §8), completo: nueve pantallas por obra, más la agenda de proveedores y las tres del estudio.

## Reglas de UI

1. **es-AR, voseo, terminología del rubro** ("Subí la documentación", "Aprobar rubro", durlock, premarco, DVH). Nada de spanglish ni de "usted".
2. **Server Components por defecto;** `"use client"` solo donde hay interactividad real (visor, grilla editable, formularios). Data fetching en el server con `getDb()`; mutaciones vía Server Actions o route handlers de `src/app/api/`.
3. **Toda página de obra valida pertenencia:** helper `requireObra(obraId)` — sesión válida + obra del estudio del usuario; si no, `notFound()`. Nunca consultes una obra por id sin pasar por ahí (aislamiento RNF-4).
4. **El visor y la planilla están acoplados por contrato, no por imports:** la fila de la planilla linkea a `/obras/[obraId]/laminas/[laminaId]?highlight=<bboxId>`; el visor lee `highlight` y resalta el bbox (RF-303: < 2 s). Ese query param es API pública interna — no lo renombres sin buscar sus usos. `resolverDestacado` lo resuelve contra las fuentes del hallazgo (`hallazgos.laminasJson`) **y también contra `valorPropuesto.fuente`**, con la de la propuesta adelante: una propuesta de la búsqueda dirigida puede vivir en una lámina que el hallazgo no cita, y sin eso el link abría el plano sin resaltar nada. Fue una **ampliación** del contrato, no un cambio: lo que resolvía antes sigue resolviendo igual.
5. **Donde hay que mirar el plano para contestar, el plano se embebe — no se navega.** La bandeja de consultas y la de deducciones son split view (`grid lg:grid-cols-2 lg:items-start`, lista a la izquierda y `<PanelVisor>` `lg:sticky` a la derecha, apilado abajo de `lg`); el `?highlight=` queda degradado a un "Abrir en página completa". El panel se alimenta solo por `GET /api/laminas/[laminaId]/marcas`. Confirmar un número que el sistema dice haber leído en algún lado, sin ver ese lado, es firmar a ciegas.
   **`destacados` se le pasa como referencia estable** (guardada en el estado de la selección, nunca recalculada en el render, y el vacío es una constante de módulo): `Overlay` hace `scrollIntoView` en un `useEffect([destacados])` y un array nuevo por render scrollea de más con cada redibujo.
6. **Estados visibles:** una lámina siempre muestra su `estado_analisis` (pendiente / procesando / analizada / bloqueada por escala / error) y una lámina bloqueada explica qué necesita (medida de referencia). Una lámina computada con la escala que el rótulo declara pero nadie verificó **lo dice** ("escala asumida") y ofrece confirmarla en un click, desde el expediente **y** desde la propia página del visor. Nada de spinners eternos sin explicación.
7. **Acciones destructivas o de aprobación piden confirmación** (aprobar rubro, descartar hallazgo) y quedan en `auditoria`.
8. Formularios con validación Zod compartida entre cliente y server (`src/types/domain.ts` exporta los schemas). El server NUNCA confía en el payload. **El `disabled` del botón es cortesía, nunca la integridad:** la regla de que una consulta se responde con todas sus medidas juntas vive en el core, porque cada `*Action` es un endpoint invocable sin pasar por la pantalla.
9. Tailwind directo, sin librería de componentes externa; primitivas propias en `src/components/ui/` (Button, Input, Select, Badge, Card, Table, Dialog). Reusalas — no dupliques estilos inline de botones.

## Mapa de rutas

```
/                                   redirige a /obras (el middleware manda a /login sin sesión)
/login, /register                   auth (register acepta código de invitación)

/obras                              lista + crear
/obras/nueva                        alta de obra

/obras/[obraId]                     tablero (rubros, huecos, compulsas, ahorro, accesos)
       /expediente                  documentos y láminas (upload, clasificación, estados),
                                    resumen ejecutivo, «Preguntale al expediente» (RF-106)
                                    y «Qué cambió» (historial de recomputos)
       /laminas/[laminaId]          visor (pdf.js + overlay SVG de entidades/hallazgos)
       /computo                     planilla por rubro (grilla editable, aprobar rubro,
                                    export, «Verificar cómputo» RF-306)
       /bandeja                     bandeja de consultas: la tarjeta trae el valor propuesto
                                    con su fuente y se confirma de a una o en lote, con el
                                    plano de esa consulta embebido al lado (split view)
       /deducciones                 bandeja de deducciones (propuestas del motor §11,
                                    validar/rechazar, memoria .md y planilla derivada .xlsx),
                                    también con el plano al lado
       /compulsas                   las compulsas del rubro, con su versión y su hash
       /compulsas/nueva             wizard de armado (rubro aprobado → snapshot → shortlist)
       /compulsas/[compulsaId]      lo que se pidió, y proveedor por proveedor: timeline,
                                    cotización con score, banderas de sustitución, repreguntas,
                                    registrar respuesta con preview, proponer negociación
       /conversaciones              todos los hilos de la obra
       /conversaciones/[contactoId] un hilo, con registro de mensajes entrantes
       /comparativa                 cuadro ítems × proveedores, ranking, benchmark,
                                    adjudicar y orden de compra
       /config                      datos de la obra, archivar y eliminar

/proveedores                        agenda del estudio (filtros por rubro y zona, opt-in WA)
/proveedores/nuevo                  alta a mano
/proveedores/importar               import CSV con preview y errores por línea

/estudio                            ahorro acumulado, accesos y notificaciones
/estudio/usuarios                   invitaciones, roles y bajas (solo titular)
/estudio/configuracion              instrucciones de extracción, desperdicios, condiciones,
                                    mandato, pesos, MEP, checklists
/estudio/precios                    lista de precios de referencia del estudio: tabla, alta a
                                    mano e import CSV con preview y errores por línea (la ve
                                    cualquier rol; los formularios, colaborador para arriba)
/estudio/auditoria                  auditoría del estudio, paginada por cursor

/api/archivos/[...ref]                              descarga de archivos del estudio
/api/laminas/[laminaId]                             reclasificar / confirmar escala
/api/laminas/[laminaId]/marcas                      GET: entidades, hallazgos y deducciones
                                                    dibujables de una lámina — lo que come el
                                                    <PanelVisor> embebido (lectura pura: no
                                                    pide rol, pero sí sesión y estudio)
/api/laminas/[laminaId]/procesar                    reproceso de una lámina
/api/obras/[obraId]/documentos                      upload y borrado de documentos
/api/obras/[obraId]/export                          XLSX del cómputo (consolidado o por rubro)
/api/obras/[obraId]/planilla-carpinterias           XLSX de la planilla derivada
/api/obras/[obraId]/deducciones/memoria             memoria de deducciones (.md)
/api/obras/[obraId]/compulsas/[compulsaId]/reporte  comparativa (.xlsx) y orden de compra (.pdf,
                                                    con `?documento=orden-compra`)
```

## Dónde vive cada cosa

- **Las pantallas son Server Components** y leen con `getDb()`. La interactividad vive en un
  `ui.tsx` al lado (`"use client"`), que recibe **solo datos serializables y ya formateados**: si un
  número tiene que salir en es-AR, se formatea en el server, no con el `toString()` de JS.
- **Las mutaciones son Server Actions** en el `actions.ts` de cada carpeta. En un archivo
  `'use server'` **todo export es un endpoint HTTP**, así que ahí van los envoltorios —sesión, obra
  del estudio, actor con el rol de la sesión, `revalidatePath`— y la lógica vive en `src/lib/`.
  Y **solo se pueden exportar funciones `async`**: una clase o una constante exportada de ahí rompe
  el build entero (lo guarda `tests/unit/exports-de-next.test.ts`).
- **Las descargas son route handlers** de `src/app/api/`, porque devuelven bytes con
  `Content-Disposition`. Un `route.ts` solo exporta los verbos HTTP y las opciones de segmento.
- **El rol se pide en el núcleo, no en la pantalla.** Esconder un botón que el server va a rechazar
  es **cortesía** —y hay que hacerla: ofrecerle a un colaborador un «Adjudicar» que va a fallar es
  mentirle—, pero la autorización la exige `requireAccion` adentro del core, porque todo `*Action`
  es un endpoint que se puede invocar sin pasar por la pantalla.
