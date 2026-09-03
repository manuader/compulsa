/**
 * La memoria de obra: el texto denso que lee el cruce y el .md que lee una
 * persona (§27 del prompt maestro).
 *
 * Las dos salidas se arman de la **misma** `EntradaMemoria`, y esa es la razón
 * de ser del módulo: si el documento que baja el arquitecto y el que le
 * mandamos al modelo salieran de dos lecturas distintas de la base, el día que
 * discrepen nadie va a saber cuál de las dos miente.
 *
 * Lo que se pinnea acá:
 *
 *  - el formato **exacto** de la línea de entidad de la compacta
 *    (`- T1 (tabique): largoM=4` bajo `## A-01`): es la entrada de un modelo,
 *    así que un cambio de formato es un cambio de prompt, no de estilo;
 *  - que las 7 secciones del §27 estén **siempre**, aunque no haya nada:
 *    una sección que desaparece se lee como "no había que mirar ahí";
 *  - que los números salgan en es-AR en el .md (`2,6 m`) y en formato máquina
 *    en la compacta (`2.6`), que es lo que cada lector entiende.
 */
import { describe, expect, it } from 'vitest';

import { memoriaCompacta, SIN_REGISTRO, type EntradaMemoria } from '@/lib/memoria/compacta';
import { renderMemoriaMd, SECCIONES_MD } from '@/lib/memoria/render';
import type { BBox } from '@/types/domain';

const BBOX: BBox = [0.1, 0.2, 0.3, 0.05];

/** Tres láminas: una completa, una con escala asumida y una sin rótulo leído. */
const LAMINAS: EntradaMemoria['laminas'] = [
  {
    id: 'lam-1',
    numeroPagina: 1,
    codigo: 'A-01',
    titulo: 'Planta baja',
    tipo: 'planta',
    escala: '1:50',
    escalaConfiable: true,
    estadoAnalisis: 'analizada',
  },
  {
    id: 'lam-2',
    numeroPagina: 2,
    codigo: 'A-02',
    titulo: 'Corte AA',
    tipo: 'corte',
    escala: '1:50',
    escalaConfiable: false,
    estadoAnalisis: 'analizada',
  },
  {
    id: 'lam-3',
    numeroPagina: 3,
    codigo: null,
    titulo: null,
    tipo: null,
    escala: null,
    escalaConfiable: false,
    estadoAnalisis: 'bloqueada_escala',
  },
];

const ENTIDADES: EntradaMemoria['entidades'] = [
  {
    id: 'ent-1',
    laminaId: 'lam-1',
    tipo: 'tabique',
    nombre: 'T1',
    bbox: BBOX,
    confianza: 0.9,
    estadoReforma: 'na',
    atributos: { largoM: 4 },
  },
  {
    id: 'ent-2',
    laminaId: 'lam-1',
    tipo: 'muro',
    nombre: 'M1',
    bbox: BBOX,
    confianza: 0.8,
    estadoReforma: 'demoler',
    // `espesorM: null` es un campo que el análisis no leyó: no es un dato.
    atributos: { largoM: 3, alturaM: 2.6, tipo: 'mamposteria', espesorM: null },
  },
  {
    id: 'ent-3',
    laminaId: 'lam-3',
    tipo: 'ambiente',
    nombre: 'Estar',
    bbox: BBOX,
    confianza: 0.7,
    estadoReforma: 'na',
    atributos: { superficieM2: 12 },
  },
];

const DATOS_OBRA: EntradaMemoria['datosObra'] = [
  {
    clave: 'altura_local.PB',
    valor: 2.6,
    unidad: 'm',
    origen: 'deducido',
    fuentes: [{ laminaId: 'lam-2', bbox: BBOX, detalle: 'nivel de piso a cielorraso' }],
    confianza: 0.8,
  },
  {
    clave: 'altura_revestimiento.general',
    valor: 2,
    unidad: 'm',
    origen: 'inferido',
    fuentes: [{ laminaId: 'lam-1', bbox: BBOX }],
    confianza: 0.5,
    metodo: 'medición gráfica sobre el dibujo a escala 1:50',
  },
];

const DEDUCCIONES: EntradaMemoria['deducciones'] = [
  {
    campo: 'alturaM',
    regla: 'planta_corte',
    confianza: 0.8,
    estado: 'validada',
    entidadNombre: 'T1',
    laminaCodigo: 'A-02',
  },
  {
    campo: 'largoM',
    regla: 'medicion_grafica',
    confianza: 0.5,
    estado: 'validada',
    entidadNombre: 'M1',
    laminaCodigo: 'A-01',
  },
  {
    campo: 'anchoM',
    regla: 'idem_tipologia',
    confianza: 0.6,
    estado: 'propuesta',
    entidadNombre: 'V1',
    laminaCodigo: 'A-01',
  },
];

const HALLAZGOS: EntradaMemoria['hallazgosAbiertos'] = [
  {
    clave: 'seco.altura_tabiques.T2',
    tipo: 'faltante',
    descripcion: 'Falta la altura del tabique T2.',
    bloqueante: true,
  },
  {
    clave: 'cruce.conflicto.ab12cd34',
    tipo: 'inconsistencia',
    descripcion: 'El corte dice 2,60 y la planta 2,80.',
    bloqueante: false,
  },
  {
    // Una consulta de dato de obra: su clave lleva adelante el namespace, que
    // es lo último que quiere leer alguien en un documento del legajo.
    clave: 'dato_obra.altura_local.1P',
    tipo: 'faltante',
    descripcion: 'Falta la altura de local del primer piso.',
    bloqueante: false,
  },
];

const OBRA: EntradaMemoria = {
  obra: { nombre: 'Casa Pérez', tipo: 'reforma' },
  laminas: LAMINAS,
  entidades: ENTIDADES,
  datosObra: DATOS_OBRA,
  deducciones: DEDUCCIONES,
  hallazgosAbiertos: HALLAZGOS,
};

/** Una obra recién creada: todo vacío, que es el caso que borra secciones. */
const VACIA: EntradaMemoria = {
  obra: { nombre: 'Casa Nueva', tipo: 'nueva' },
  laminas: [],
  entidades: [],
  datosObra: [],
  deducciones: [],
  hallazgosAbiertos: [],
};

// ---------------------------------------------------------------------------
// memoriaCompacta
// ---------------------------------------------------------------------------

describe('memoriaCompacta: el texto que lee el cruce', () => {
  it('escribe la entidad EXACTAMENTE como `- T1 (tabique): largoM=4` bajo `## A-01`', () => {
    const texto = memoriaCompacta(OBRA);

    expect(texto).toContain('## A-01\n- T1 (tabique): largoM=4\n');
  });

  it('agrupa por lámina, marca el estado de reforma y saltea los atributos sin leer', () => {
    const texto = memoriaCompacta(OBRA);

    // Un solo encabezado por lámina, con sus dos entidades seguidas.
    expect(texto).toContain(
      '## A-01\n- T1 (tabique): largoM=4\n- M1 (muro, demoler): largoM=3; alturaM=2.6; tipo=mamposteria\n',
    );
    // `espesorM: null` no es un dato: no se escribe.
    expect(texto).not.toContain('espesorM');
  });

  it('la lámina sin código se nombra por id: inventarle una etiqueta la haría irresoluble', () => {
    const texto = memoriaCompacta(OBRA);

    expect(texto).toContain('## lam-3\n- Estar (ambiente): superficieM2=12\n');
  });

  it('el índice dice qué escala tiene cada lámina y si está confirmada o asumida', () => {
    const texto = memoriaCompacta(OBRA);

    expect(texto).toContain('- A-01 · Planta baja · planta · esc. 1:50 (confirmada) · analizada');
    expect(texto).toContain('- A-02 · Corte AA · corte · esc. 1:50 (asumida) · analizada');
    expect(texto).toContain('- lam-3 · sin título · sin clasificar · sin escala · bloqueada_escala');
  });

  it('los números van en formato máquina, no en es-AR: el que lee esto es un modelo', () => {
    const texto = memoriaCompacta(OBRA);

    expect(texto).toContain('- altura_local.PB = 2.6 m · deducido · confianza 0.80 · A-02');
    // Ningún valor que escriba la memoria sale con coma decimal. (La coma de
    // «2,60» que se ve más abajo es texto de una descripción, no un número
    // formateado acá: por eso el assert mira el valor, no el documento entero.)
    expect(texto).not.toContain('= 2,6');
    expect(texto).not.toContain('alturaM=2,6');
  });

  it('lista las deducciones ya aplicadas y deja afuera las que todavía se proponen', () => {
    const texto = memoriaCompacta(OBRA);

    expect(texto).toContain('- T1 · alturaM · planta_corte · confianza 0.80 · A-02');
    // V1 está en propuesta: todavía no es parte del estado de la obra.
    expect(texto).not.toContain('V1');
  });

  it('dice qué falta y cuál de esos huecos bloquea', () => {
    const texto = memoriaCompacta(OBRA);

    expect(texto).toContain(
      '- [bloqueante] seco.altura_tabiques.T2 (faltante): Falta la altura del tabique T2.',
    );
    expect(texto).toContain(
      '- cruce.conflicto.ab12cd34 (inconsistencia): El corte dice 2,60 y la planta 2,80.',
    );
  });

  it('con la obra vacía mantiene las cinco secciones y dice que no hay nada', () => {
    const texto = memoriaCompacta(VACIA);

    expect(texto).toContain('# OBRA: Casa Nueva (nueva)');
    for (const seccion of ['LÁMINAS', 'ENTIDADES POR LÁMINA', 'DATOS DE OBRA', 'DEDUCCIONES APLICADAS', 'QUÉ FALTA']) {
      expect(texto).toContain(`# ${seccion}\n${SIN_REGISTRO}`);
    }
  });
});

// ---------------------------------------------------------------------------
// renderMemoriaMd
// ---------------------------------------------------------------------------

describe('renderMemoriaMd: las 7 secciones del §27', () => {
  it('están las 7 aunque la obra esté vacía, cada una diciendo que no hay nada', () => {
    const md = renderMemoriaMd(VACIA);

    expect(SECCIONES_MD).toHaveLength(7);
    for (const seccion of SECCIONES_MD) {
      expect(md).toContain(`## ${seccion}\n\n${SIN_REGISTRO}`);
    }
  });

  it('salen en el orden del §27, sin repetirse', () => {
    const md = renderMemoriaMd(OBRA);
    const encabezados = md
      .split('\n')
      .filter((linea) => linea.startsWith('## '))
      .map((linea) => linea.slice(3));

    expect(encabezados).toEqual([...SECCIONES_MD]);
  });

  it('encabeza con la obra y con la confianza promedio de lo que se leyó', () => {
    const md = renderMemoriaMd(OBRA);

    expect(md).toContain('# Memoria de obra — Casa Pérez');
    // (0,9 + 0,8 + 0,7 + 0,8 + 0,5) / 5 = 0,74 sobre 3 elementos y 2 datos de obra.
    expect(md).toContain(
      'Obra de reforma · 3 láminas · 3 elementos · confianza promedio de lo leído: 74%.',
    );
  });

  it('sin nada leído no promedia nada: el encabezado lo dice y no inventa un número', () => {
    const md = renderMemoriaMd(VACIA);

    expect(md).toContain('Obra nueva · 0 láminas · 0 elementos.');
    expect(md).not.toContain('confianza promedio');
  });

  it('la documentación analizada distingue la escala confirmada de la asumida', () => {
    const md = renderMemoriaMd(OBRA);

    expect(md).toContain('| A-01 | Planta baja | Planta | 1:50 (confirmada) | Analizada |');
    expect(md).toContain('| A-02 | Corte AA | Corte | 1:50 (asumida) | Analizada |');
    // Una lámina sin código leído se nombra por su página, como en toda la app:
    // acá salía su uuid, en un documento que se adjunta al legajo.
    expect(md).toContain('| Página 3 | — | — | sin escala | Bloqueada por escala |');
    expect(md).not.toContain('lam-3');
  });

  it('los datos de obra van con su origen, su confianza y las láminas que los sostienen', () => {
    const md = renderMemoriaMd(OBRA);

    // La clave es nuestra; el nombre del hecho es el que el arquitecto lee, y
    // sale del mismo traductor que usa la bandeja.
    expect(md).toContain('| Altura de local en PB | 2,6 m | Deducido | 80% | A-02 | — |');
  });

  it('los elementos van agrupados por lámina, con su estado de reforma', () => {
    const md = renderMemoriaMd(OBRA);

    expect(md).toContain('### A-01');
    // Los nombres de campo también se traducen: salían `largoM = 3; alturaM = 2,6`.
    expect(md).toContain('| T1 | Tabique | — | largo = 4 |');
    expect(md).toContain(
      '| M1 | Muro | A demoler | largo = 3; altura = 2,6; tipo = mamposteria |',
    );
    expect(md).toContain('### Página 3');
  });

  it('las relaciones y deducciones nombran la regla en criollo y su estado', () => {
    const md = renderMemoriaMd(OBRA);

    expect(md).toContain('| T1 | altura | Planta ↔ corte | 80% | Validada | A-02 |');
    // La propuesta también se muestra: es una relación leída, todavía sin decidir.
    expect(md).toContain('| V1 | ancho | Ídem tipología | 60% | Propuesta | A-01 |');
  });

  it('separa conflictos de información faltante por el tipo del hallazgo', () => {
    const md = renderMemoriaMd(OBRA);
    const conflictos = seccion(md, 'Conflictos');
    const faltante = seccion(md, 'Información faltante');

    expect(conflictos).toContain('cruce.conflicto.ab12cd34');
    expect(conflictos).not.toContain('seco.altura_tabiques.T2');
    expect(faltante).toContain('| seco.altura_tabiques.T2 | Faltante | Falta la altura del tabique T2. | Sí |');
    expect(faltante).not.toContain('cruce.conflicto.ab12cd34');
    // La de rubro conserva su clave —se lee como lo que es—; la de dato de obra
    // se traduce, porque su clave es puro namespace nuestro.
    expect(faltante).toContain('| Altura de local en 1P | Faltante |');
    expect(faltante).not.toContain('dato_obra.altura_local.1P');
  });

  it('los datos inferidos van con su método, y la medición gráfica también', () => {
    const md = renderMemoriaMd(OBRA);
    const inferidos = seccion(md, 'Datos inferidos');

    expect(inferidos).toContain(
      '| Altura de revestimiento | 2 m | medición gráfica sobre el dibujo a escala 1:50 | 50% |',
    );
    // La medición gráfica de un campo de entidad: el valor vive en la planilla,
    // acá se cita el hecho y el método.
    expect(inferidos).toContain('| M1 · largo | — | Medición gráfica sobre el dibujo | 50% |');
    // Lo deducido por regla documental NO es inferido: no entra a esta sección.
    expect(inferidos).not.toContain('altura_local.PB');
  });

  it('cierra con el descargo: la plataforma asiste, el que firma es el arquitecto', () => {
    const md = renderMemoriaMd(OBRA);

    expect(md).toContain('_La plataforma asiste');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('escapa los pipes del contenido para no romper la tabla', () => {
    const md = renderMemoriaMd({
      ...VACIA,
      hallazgosAbiertos: [
        { clave: 'x.y', tipo: 'faltante', descripcion: 'Falta A | B.', bloqueante: false },
      ],
    });

    expect(md).toContain('Falta A \\| B.');
  });
});

/** El texto de una sección del .md, de su encabezado al siguiente. */
function seccion(md: string, titulo: string): string {
  const desde = md.indexOf(`## ${titulo}\n`);
  expect(desde).toBeGreaterThanOrEqual(0);
  const resto = md.slice(desde + titulo.length + 4);
  const hasta = resto.indexOf('\n## ');
  return hasta === -1 ? resto : resto.slice(0, hasta);
}
