/**
 * Cada acción de la auditoría, dicha en es-AR.
 *
 * Vive en su propio archivo y no adentro de `page.tsx` por dos razones, y la
 * segunda es la que importa: un `page.tsx` es de los dos archivos cuyos exports
 * valida Next (CLAUDE.md §9), así que desde ahí este mapa no se puede exportar
 * — y sin exportarlo no hay test que verifique que está completo. Lo verifica
 * `tests/unit/auditoria-frases.test.ts`, que barre el código buscando acciones
 * y falla si alguna no tiene frase.
 *
 * La columna `accion` guarda verbos en `snake_case` porque es una clave estable
 * que se filtra y se agrupa; este mapa es la traducción para leerla. Una acción
 * que no esté acá se muestra humanizada (`lamina_reintentada` → "lamina
 * reintentada"): mejor un texto imperfecto que una fila que no se entiende, y
 * por eso el fallback existe y se queda.
 *
 * **El fallback no es una excusa para no completar la tabla.** Acá vivió durante
 * una ola un comentario que daba `hallazgo_reabierto` como ejemplo de acción
 * "que ya no emite nadie" — y para cuando alguien lo leyó, el recompute había
 * vuelto a emitirla (§5.8: una consulta que cerró el propio recompute se reabre
 * si el dato que la resolvía se va). Después la ola del expediente agregó once
 * acciones nuevas sin frase, y once de ellas eran **las de falla**: justo las
 * filas que se van a leer con apuro. La auditoría es la pantalla donde se va a
 * mirar qué pasó. Si agregás una acción nueva a `registrarAuditoria`, agregala
 * también acá, en el mismo commit — y ahora el test te lo cobra.
 *
 * Módulo puro: sin React, sin imports de la app.
 */
export const FRASE_ACCION: Record<string, string> = {
  analisis_fase: 'El análisis pasó a otra etapa',
  analisis_llm: 'Analizó una lámina con el modelo',
  busqueda_dirigida: 'Buscó en la documentación los datos que faltaban',
  busqueda_fallida: 'No pudo buscar los datos que faltaban en la documentación',
  busqueda_llm: 'Buscó un dato en una lámina con el modelo',
  checklist_item_actualizado: 'Cambió un ítem del checklist',
  computo_item_actualizado: 'El recompute actualizó un ítem',
  computo_item_anulado: 'Anuló un ítem del cómputo',
  computo_item_creado: 'Agregó un ítem al cómputo',
  computo_item_desvinculado: 'Un ítem perdió su entidad de origen',
  computo_item_editado: 'Editó un ítem del cómputo',
  computo_item_precio: 'Le puso precio a un ítem del cómputo',
  computo_recalculado: 'Recalculó el cómputo de la obra',
  compulsa_adjudicada: 'Adjudicó una compulsa a un proveedor',
  config_estudio_actualizada: 'Cambió la configuración del estudio',
  contacto_estado_cambiado: 'Cambió el estado de un proveedor en una compulsa',
  cruce_aplicado: 'Cruzó el expediente y aplicó lo que encontró',
  cruce_fallido: 'No pudo cruzar el expediente',
  cruce_llm: 'Cruzó el expediente con el modelo',
  dato_obra_actualizado: 'Corrigió un dato que vale para toda la obra',
  dato_obra_definido: 'Cargó un dato de toda la obra',
  dato_obra_escrito: 'Escribió un dato que vale para toda la obra',
  dato_obra_rechazado: 'Sacó de la obra un dato que había escrito el sistema',
  deduccion_actualizada: 'Cambió una deducción propuesta',
  deduccion_aplicada: 'El sistema aplicó una deducción',
  deduccion_autovalidada: 'El sistema validó una deducción y la aplicó',
  deduccion_borrada: 'Se descartó una deducción cuyo elemento ya no está en la lámina',
  deduccion_contradiccion_resuelta: 'La documentación volvió a coincidir con una deducción',
  deduccion_contradicha: 'La documentación superó una deducción',
  deduccion_propuesta: 'El motor propuso una deducción',
  deduccion_rechazada: 'Rechazó una deducción',
  deduccion_retirada: 'Se retiró una deducción que la documentación dejó de sostener',
  deduccion_revertida: 'Revirtió el dato de una deducción rechazada',
  deduccion_validada: 'Validó una deducción',
  documento_eliminado: 'Eliminó un documento',
  documento_subido: 'Subió un documento',
  entidad_actualizada: 'Completó un dato de una entidad',
  entidades_descartadas: 'Descartó lecturas que no cumplían el contrato de análisis',
  entidades_unificadas: 'Dos lecturas del mismo elemento pasaron a ser una',
  hallazgo_abierto: 'Se abrió una consulta',
  hallazgo_actualizado: 'Cambió una consulta',
  hallazgo_descartado: 'Descartó una consulta',
  hallazgo_reabierto: 'Se reabrió una consulta porque el dato se fue',
  hallazgo_respondido: 'Respondió una consulta',
  hallazgo_sin_resultado: 'No encontró en la documentación el dato que una consulta pedía',
  hallazgo_valor_propuesto: 'Encontró en la documentación un valor y lo propuso',
  inventario_llm: 'Inventarió las láminas con el modelo',
  invitacion_creada: 'Generó una invitación',
  invitacion_usada: 'Se sumó al estudio con una invitación',
  lamina_analizada: 'Terminó de analizar una lámina',
  lamina_bloqueada_escala: 'Bloqueó una lámina por escala no verificable',
  lamina_clasificada: 'Clasificó una lámina',
  lamina_creada: 'Separó una lámina del PDF',
  lamina_error: 'Falló el análisis de una lámina',
  lamina_extraccion_fallida: 'No pudo leer los elementos de una lámina',
  lamina_inventariada: 'Leyó el rótulo de una lámina',
  lamina_inventario_fallido: 'No pudo leer el rótulo de una lámina',
  lamina_escala_confirmada: 'Confirmó la escala de una lámina',
  lamina_procesamiento_omitido: 'Salteó una lámina ya tomada',
  lamina_procesando: 'Tomó una lámina para analizar',
  obra_archivada: 'Archivó la obra',
  obra_archivos_pendientes: 'Quedaron archivos sin borrar en el storage',
  medicion_fallida: 'No pudo medir una entidad sobre el dibujo',
  obra_creada: 'Creó la obra',
  obra_desarchivada: 'Desarchivó la obra',
  obra_editada: 'Editó los datos de la obra',
  obra_eliminada: 'Eliminó la obra definitivamente',
  precio_referencia_creado: 'Agregó un precio a la lista del estudio',
  precio_referencia_editado: 'Cambió un precio de la lista del estudio',
  precio_referencia_eliminado: 'Sacó un precio de la lista del estudio',
  precios_importados: 'Importó una lista de precios desde un CSV',
  presupuesto_llm: 'Leyó un presupuesto con el modelo',
  proveedor_creado: 'Dio de alta un proveedor',
  proveedor_editado: 'Editó un proveedor de la agenda',
  proveedor_opt_in: 'Un proveedor aceptó que se lo contacte por WhatsApp',
  proveedor_opt_out: 'Un proveedor pidió que no se lo contacte por WhatsApp',
  proveedores_importados: 'Importó proveedores desde un CSV',
  qa_llm: 'Contestó una pregunta del expediente con el modelo',
  resumen_generado: 'Rearmó el resumen ejecutivo de la obra',
  recomputo_fallido: 'Falló el recálculo del cómputo',
  recomputo_registrado: 'Registró qué cambió al recalcular',
  resumen_fallido: 'No pudo rearmar el resumen ejecutivo',
  rubro_aprobado: 'Aprobó el cómputo de un rubro',
  usuario_activo_cambiado: 'Activó o dio de baja a un usuario',
  usuario_rol_cambiado: 'Cambió el rol de un usuario',
  verificacion_computo: 'Verificó el cómputo con una segunda lectura',
};

export function frase(accion: string): string {
  return FRASE_ACCION[accion] ?? accion.replace(/_/g, ' ');
}
