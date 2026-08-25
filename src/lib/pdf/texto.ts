/**
 * Extracción de texto de un PDF con pdfjs-dist (build **legacy**, sin canvas).
 *
 * Acá solo se usa `getTextContent()`: nunca rasterizamos. `@napi-rs/canvas` está
 * bloqueado a propósito en el `overrides` de package.json (el binario nativo
 * rompe el "corre entero offline" del proyecto), así que cualquier camino de
 * render de pdfjs está fuera de alcance por diseño.
 *
 * El texto que sale de acá viaja en `LaminaInput.textoExtraido` y le da al
 * provider de análisis el contenido literal del rótulo y las referencias, que es
 * mucho más confiable que leerlas de la imagen.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

type ModuloPdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

const requerir = createRequire(import.meta.url);

/**
 * Avisos que pdfjs escribe al importarse en Node cuando no encuentra canvas.
 * Los tres polyfills (`DOMMatrix`, `ImageData`, `Path2D`) solo hacen falta para
 * rasterizar; para `getTextContent()` son ruido. Los filtramos para no ensuciar
 * la salida de los tests, y solo durante el import.
 */
const AVISOS_SIN_CANVAS =
  /^Warning: Cannot (access the `require` function|load "@napi-rs\/canvas"|polyfill `(DOMMatrix|ImageData|Path2D)`)/;

let moduloPdfjs: Promise<ModuloPdfjs> | null = null;

/**
 * pdfjs 4.10 lee cmaps y fuentes estándar del disco con
 * `process.getBuiltinModule`, que existe recién desde Node 22.3. En Node 21
 * (la versión del proyecto) eso tira `TypeError` y pdfjs degrada a un
 * "Unable to load font data" por lámina. El shim devuelve el builtin por
 * `require`, que es exactamente lo que hace la API real.
 */
function prepararEntornoNode(): void {
  const proceso = process as NodeJS.Process & {
    getBuiltinModule?: (id: string) => unknown;
  };
  if (typeof proceso.getBuiltinModule === 'function') return;
  proceso.getBuiltinModule = (id: string) => requerir(id.startsWith('node:') ? id : `node:${id}`);
}

async function cargarPdfjs(): Promise<ModuloPdfjs> {
  moduloPdfjs ??= (async () => {
    prepararEntornoNode();
    const logOriginal = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && AVISOS_SIN_CANVAS.test(args[0])) return;
      logOriginal(...args);
    };
    try {
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } finally {
      console.log = logOriginal;
    }
  })();
  return moduloPdfjs;
}

/**
 * Rutas a los recursos que pdfjs trae en su propio paquete. Sin ellos avisa por
 * cada fuente estándar y pierde el mapeo de caracteres de las fuentes CID
 * (habitual en planos de estudios). Si no se pueden resolver (bundler que
 * reescribe el módulo, por ejemplo) seguimos sin ellos: el texto sale igual.
 */
function recursosPdfjs(): { standardFontDataUrl?: string; cMapUrl?: string } {
  try {
    const raiz = new URL('../../', pathToFileURL(requerir.resolve('pdfjs-dist/legacy/build/pdf.mjs')));
    return {
      standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', raiz)),
      cMapUrl: fileURLToPath(new URL('cmaps/', raiz)),
    };
  } catch {
    return {};
  }
}

let recursos: { standardFontDataUrl?: string; cMapUrl?: string } | null = null;

/**
 * Texto plano del PDF, páginas separadas por una línea en blanco.
 *
 * Recibe normalmente una lámina de una sola página (salida de `separarPaginas`),
 * pero funciona con documentos de N páginas.
 */
export async function extraerTexto(pdfBytes: Uint8Array): Promise<string> {
  const pdfjs = await cargarPdfjs();
  recursos ??= recursosPdfjs();

  const documento = await pdfjs.getDocument({
    // Copia deliberada: pdfjs se queda con el buffer y lo deja inutilizable.
    // El pipeline reusa los mismos bytes para guardarlos y para analizarlos.
    data: new Uint8Array(pdfBytes),
    isEvalSupported: false,
    cMapPacked: true,
    ...recursos,
  }).promise;

  try {
    const paginas: string[] = [];
    for (let numero = 1; numero <= documento.numPages; numero++) {
      const pagina = await documento.getPage(numero);
      const contenido = await pagina.getTextContent();

      let texto = '';
      for (const item of contenido.items) {
        // Los `TextMarkedContent` (etiquetas de estructura) no traen texto.
        if (!('str' in item)) continue;
        texto += item.str;
        if (item.hasEOL) texto += '\n';
      }
      paginas.push(texto.trim());
      pagina.cleanup();
    }
    return paginas.join('\n\n').trim();
  } finally {
    await documento.destroy();
  }
}
