/**
 * Convención de rutas del storage.
 *
 *   estudios/<estudioId>/obras/<obraId>/documentos/<docId>/original.pdf
 *   estudios/<estudioId>/obras/<obraId>/documentos/<docId>/laminas/p001.pdf
 *
 * La ref viaja por la URL (`/api/archivos/[...ref]`), y por eso arranca por el
 * estudio y la obra: el handler decide la pertenencia leyendo la propia ref
 * —sin escanear tablas— y recién después confirma contra la base que esa ref
 * pertenece a un documento o a una lámina de esa obra.
 *
 * Vive en su propio módulo, separado de `procesar.ts`, para que el handler que
 * sirve bytes no arrastre pdfjs, pdf-lib ni los providers de análisis solo para
 * parsear una ruta.
 *
 * Módulo puro: sin I/O, sin DB.
 */

export const MIME_PDF = 'application/pdf';

const RE_UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const RE_REF_ARCHIVO = new RegExp(
  `^estudios/(${RE_UUID})/obras/(${RE_UUID})/documentos/(${RE_UUID})/(?:original\\.pdf|laminas/p\\d{3}\\.pdf)$`,
);

export function prefijoDocumento(estudioId: string, obraId: string, documentoId: string): string {
  return `estudios/${estudioId}/obras/${obraId}/documentos/${documentoId}`;
}

export function refDocumento(estudioId: string, obraId: string, documentoId: string): string {
  return `${prefijoDocumento(estudioId, obraId, documentoId)}/original.pdf`;
}

export function refLamina(
  estudioId: string,
  obraId: string,
  documentoId: string,
  numeroPagina: number,
): string {
  const pagina = String(numeroPagina).padStart(3, '0');
  return `${prefijoDocumento(estudioId, obraId, documentoId)}/laminas/p${pagina}.pdf`;
}

export interface RefArchivo {
  estudioId: string;
  obraId: string;
  documentoId: string;
}

/** `null` si la ref no tiene la forma canónica: eso es un "no existe", no un 500. */
export function parsearRefArchivo(ref: string): RefArchivo | null {
  const coincidencia = RE_REF_ARCHIVO.exec(ref);
  if (!coincidencia) return null;
  return {
    estudioId: coincidencia[1],
    obraId: coincidencia[2],
    documentoId: coincidencia[3],
  };
}
