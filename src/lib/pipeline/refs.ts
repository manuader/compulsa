/**
 * Convención de rutas del storage.
 *
 *   estudios/<estudioId>/obras/<obraId>/documentos/<docId>/original.pdf
 *   estudios/<estudioId>/obras/<obraId>/documentos/<docId>/laminas/p001.pdf
 *   estudios/<estudioId>/obras/<obraId>/compulsas/<compulsaId>/recortes/NN-clave.pdf
 *
 * La ref viaja por la URL (`/api/archivos/[...ref]`), y por eso arranca por el
 * estudio y la obra: el handler decide la pertenencia leyendo la propia ref
 * —sin escanear tablas— y recién después confirma contra la base que esa ref
 * pertenece a un documento, a una lámina **o a una compulsa** de esa obra.
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

/**
 * Los recortes de plano que acompañan un pedido de cotización (RF-703).
 *
 * El nombre del archivo lo arma `guardarRecortes` de `src/lib/compulsa/flujo.ts`
 * como `NN-clave-item.pdf`: índice de **al menos** dos dígitos (`padStart(2)`,
 * así que con más de 99 recortes son tres) y la `claveItem` pasada por
 * `comoNombreDeArchivo` — minúsculas, sin tildes, separada por guiones. El
 * patrón es cerrado a propósito: la ref viene de la URL y un `[^/]+` acá sería
 * la puerta por la que entra `..%2Fsecreto`.
 */
const RE_REF_RECORTE = new RegExp(
  `^estudios/(${RE_UUID})/obras/(${RE_UUID})/compulsas/(${RE_UUID})/recortes/\\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*\\.pdf$`,
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

export interface RefDocumento {
  estudioId: string;
  obraId: string;
  documentoId: string;
}

export interface RefRecorte {
  estudioId: string;
  obraId: string;
  compulsaId: string;
}

/**
 * Las dos clases de archivo que el storage sirve por URL.
 *
 * La unión **no lleva un campo discriminante** (`tipo: 'documento' | 'recorte'`)
 * a propósito: la forma del caso documento es contrato pinneado en
 * `tests/integration/pipeline.test.ts` (`toEqual({ estudioId, obraId,
 * documentoId })`), y agregarle una clave rompería ese test por cosmética. Se
 * distingue con `esRefRecorte()`, que es un `in` y narrowea igual de bien.
 */
export type RefArchivo = RefDocumento | RefRecorte;

export function esRefRecorte(ref: RefArchivo): ref is RefRecorte {
  return 'compulsaId' in ref;
}

/**
 * `null` si la ref no tiene la forma canónica: eso es un "no existe", no un 500.
 *
 * **Ojo, el que llama:** que la forma sea válida NO prueba pertenencia. Que la
 * ref nombre un estudio y una obra es lo que permite decidirla sin escanear
 * tablas, pero el handler tiene que confirmar las dos cosas —la obra es del
 * estudio de la sesión y el objeto nombrado (documento, lámina o compulsa) es de
 * esa obra— antes de leer un solo byte. Ver `/api/archivos/[...ref]`.
 */
export function parsearRefArchivo(ref: string): RefArchivo | null {
  const documento = RE_REF_ARCHIVO.exec(ref);
  if (documento) {
    return {
      estudioId: documento[1],
      obraId: documento[2],
      documentoId: documento[3],
    };
  }

  const recorte = RE_REF_RECORTE.exec(ref);
  if (recorte) {
    return {
      estudioId: recorte[1],
      obraId: recorte[2],
      compulsaId: recorte[3],
    };
  }

  return null;
}
