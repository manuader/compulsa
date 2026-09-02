/**
 * Qué plano abre la bandeja cuando el arquitecto pide ver una consulta.
 *
 * La bandeja y el visor viven ahora en la misma pantalla, y la pregunta que
 * contesta este módulo es la que decide si el split view sirve o no: **de las
 * láminas que la consulta toca, cuál se abre y qué se resalta**.
 *
 * La respuesta no es "la primera citada". Cuando la búsqueda dirigida encuentra
 * el ancho de FP01 en la planilla de carpinterías, la consulta está citada en
 * la planta (A-01) pero el número que hay que confirmar se leyó en DET00: abrir
 * A-01 mostraría el hueco del que se pregunta y no la fila de la que salió el
 * dato. Confirmar sin ver esa fila es confirmar a ciegas, que es justo lo que
 * la ola entera viene a evitar.
 *
 * Los tres helpers son puros y viven en el `ui.tsx` de la bandeja, que es un
 * `'use client'`: acá se testean sin render, que es donde está la lógica.
 */
import { describe, expect, it } from 'vitest';

import {
  fuentesDeAfectadas,
  type FuenteVista,
} from '@/app/obras/[obraId]/bandeja/plano';
import {
  armarMirada,
  destacadosDeConsulta,
  laminasDeConsulta,
  miradaVigente,
  type ConsultaVista,
  type GrupoConsultas,
} from '@/app/obras/[obraId]/bandeja/ui';
import type { BBox } from '@/types/domain';

const A01 = '11111111-1111-4111-8111-111111111111';
const DET00 = '22222222-2222-4222-8222-222222222222';

const HUECO: BBox = [0.1, 0.2, 0.05, 0.1];
const OTRO_HUECO: BBox = [0.4, 0.2, 0.05, 0.1];
const FILA_PLANILLA: BBox = [0.6, 0.35, 0.3, 0.04];

/** Una consulta de la bandeja con lo mínimo, y lo que el test necesite encima. */
function consulta(extra: Partial<ConsultaVista> = {}): ConsultaVista {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    clave: 'aberturas.FP01.faltante',
    tipo: 'faltante',
    rubro: 'aberturas',
    descripcion: 'Falta el ancho y el alto de FP01.',
    bloqueante: true,
    estado: 'abierto',
    campos: ['anchoM', 'altoM'],
    campo: 'anchoM',
    entidad: 'Abertura FP01',
    esEscala: false,
    datoObra: null,
    laminas: [{ laminaId: A01, etiqueta: 'A-01 · PLANTA PB' }],
    fuentes: [{ laminaId: A01, bbox: HUECO }],
    valorPropuesto: null,
    respuesta: null,
    ...extra,
  };
}

/** La misma consulta, con el dato ya propuesto desde la planilla DET00. */
function conPropuestaEnPlanilla(): ConsultaVista {
  return consulta({
    valorPropuesto: {
      valores: { anchoM: '0,90', altoM: '2,05' },
      origen: 'busqueda_dirigida',
      confianza: 0.85,
      fuente: { laminaId: DET00, etiqueta: 'DET00', bbox: FILA_PLANILLA },
    },
  });
}

describe('laminasDeConsulta: cuál se abre primero', () => {
  it('sin propuesta, la primera citada', () => {
    expect(laminasDeConsulta(consulta())).toEqual([
      { laminaId: A01, etiqueta: 'A-01 · PLANTA PB', esFuenteDeLaPropuesta: false },
    ]);
  });

  it('con propuesta, la lámina donde se leyó el dato va primero', () => {
    expect(laminasDeConsulta(conPropuestaEnPlanilla())).toEqual([
      { laminaId: DET00, etiqueta: 'DET00', esFuenteDeLaPropuesta: true },
      { laminaId: A01, etiqueta: 'A-01 · PLANTA PB', esFuenteDeLaPropuesta: false },
    ]);
  });

  it('la lámina de la propuesta no se repite si además está citada', () => {
    const fila = consulta({
      laminas: [
        { laminaId: A01, etiqueta: 'A-01 · PLANTA PB' },
        { laminaId: DET00, etiqueta: 'DET00 · PLANILLA DE CARPINTERÍAS' },
      ],
      valorPropuesto: {
        valores: { anchoM: '0,90' },
        origen: 'busqueda_dirigida',
        confianza: 0.85,
        fuente: { laminaId: DET00, etiqueta: 'DET00', bbox: FILA_PLANILLA },
      },
    });

    expect(laminasDeConsulta(fila).map((lamina) => lamina.laminaId)).toEqual([DET00, A01]);
  });

  it('una consulta sin láminas ni propuesta no ofrece nada', () => {
    expect(laminasDeConsulta(consulta({ laminas: [], fuentes: [] }))).toEqual([]);
  });

  it('una lámina citada que la página no supo nombrar no entra', () => {
    // `page.tsx` solo arma `laminas` con las que existen en la obra; una fuente
    // huérfana en `fuentes` no se puede abrir (la ruta de marcas da 404).
    const huerfana = consulta({
      laminas: [],
      fuentes: [{ laminaId: '44444444-4444-4444-8444-444444444444', bbox: HUECO }],
    });

    expect(laminasDeConsulta(huerfana)).toEqual([]);
    expect(armarMirada(huerfana, '44444444-4444-4444-8444-444444444444')).toBeNull();
  });
});

describe('destacadosDeConsulta: qué se resalta y en qué orden', () => {
  it('en la lámina de la propuesta, el recuadro de la propuesta', () => {
    expect(destacadosDeConsulta(conPropuestaEnPlanilla(), DET00)).toEqual([FILA_PLANILLA]);
  });

  it('en la lámina citada, los recuadros de la consulta (la propuesta no está acá)', () => {
    expect(destacadosDeConsulta(conPropuestaEnPlanilla(), A01)).toEqual([HUECO]);
  });

  it('el recuadro de la propuesta va primero: es a donde scrollea el overlay', () => {
    const fila = consulta({
      fuentes: [
        { laminaId: A01, bbox: HUECO },
        { laminaId: A01, bbox: OTRO_HUECO },
      ],
      valorPropuesto: {
        valores: { anchoM: '0,90' },
        origen: 'lectura_baja_confianza',
        confianza: 0.62,
        fuente: { laminaId: A01, etiqueta: 'A-01', bbox: OTRO_HUECO },
      },
    });

    expect(destacadosDeConsulta(fila, A01)).toEqual([OTRO_HUECO, HUECO]);
  });

  it('el mismo recuadro citado y propuesto se dibuja una sola vez', () => {
    const fila = consulta({
      valorPropuesto: {
        valores: { anchoM: '0,90' },
        origen: 'lectura_baja_confianza',
        confianza: 0.62,
        fuente: { laminaId: A01, etiqueta: 'A-01', bbox: [...HUECO] },
      },
    });

    expect(destacadosDeConsulta(fila, A01)).toEqual([HUECO]);
  });

  it('las fuentes de otras láminas no se cuelan', () => {
    const fila = consulta({
      laminas: [
        { laminaId: A01, etiqueta: 'A-01 · PLANTA PB' },
        { laminaId: DET00, etiqueta: 'DET00 · PLANILLA' },
      ],
      fuentes: [
        { laminaId: A01, bbox: HUECO },
        { laminaId: DET00, bbox: FILA_PLANILLA },
      ],
    });

    expect(destacadosDeConsulta(fila, A01)).toEqual([HUECO]);
    expect(destacadosDeConsulta(fila, DET00)).toEqual([FILA_PLANILLA]);
  });
});

describe('armarMirada: lo que entra al estado del panel', () => {
  it('la lámina que el botón de arriba abre es la de la propuesta, con su recuadro', () => {
    const fila = conPropuestaEnPlanilla();
    // El primer botón de la tarjeta es el primero de `laminasDeConsulta`: la
    // regla «la de la propuesta, y si no la primera citada» es esa lista.
    const primera = laminasDeConsulta(fila)[0]!;

    expect(armarMirada(fila, primera.laminaId)).toEqual({
      consultaId: fila.id,
      laminaId: DET00,
      destacados: [FILA_PLANILLA],
      etiqueta: 'DET00 · Abertura FP01',
    });
  });

  it('la otra lámina abre la citada con los recuadros de la consulta', () => {
    expect(armarMirada(conPropuestaEnPlanilla(), A01)).toEqual({
      consultaId: '33333333-3333-4333-8333-333333333333',
      laminaId: A01,
      destacados: [HUECO],
      etiqueta: 'A-01 · PLANTA PB · Abertura FP01',
    });
  });

  it('una lámina que no es de esta consulta no se abre', () => {
    expect(armarMirada(conPropuestaEnPlanilla(), '55555555-5555-4555-8555-555555555555')).toBeNull();
  });

  it('sin entidad apuntada, la etiqueta cae a la clave del hallazgo', () => {
    const mirada = armarMirada(consulta({ entidad: null, clave: 'escala.A-01' }), A01);
    expect(mirada?.etiqueta).toBe('A-01 · PLANTA PB · escala.A-01');
  });

  it('una consulta sin nada que mostrar no abre el panel', () => {
    expect(armarMirada(consulta({ laminas: [], fuentes: [] }), A01)).toBeNull();
  });
});

/**
 * El cuarto helper: el guard de "no fantasmas".
 *
 * Confirmar o descartar revalida la pantalla y la consulta desaparece del
 * filtro «Abiertas». El panel de al lado la seguía mostrando —con su nombre y
 * su plano— porque la `Mirada` vive en el estado del cliente: el arquitecto veía
 * abierto el plano de una decisión que ya había tomado. El estado no se limpia
 * a propósito (volver al filtro donde la consulta vive la vuelve a mostrar), así
 * que la regla es de render y hasta acá estaba sin test.
 */
describe('miradaVigente: la consulta del panel sigue en la lista', () => {
  const fila = conPropuestaEnPlanilla();
  const mirada = armarMirada(fila, DET00)!;

  function grupos(consultas: ConsultaVista[]): GrupoConsultas[] {
    return [{ rubro: 'aberturas', titulo: 'Aberturas', consultas }];
  }

  it('la consulta que sigue en la lista mantiene el panel, con la MISMA referencia', () => {
    const vigente = miradaVigente(mirada, grupos([fila]));
    expect(vigente).toBe(mirada); // la referencia estable que `Overlay` necesita
  });

  it('la consulta que ya no está en el filtro cierra el panel', () => {
    expect(miradaVigente(mirada, grupos([consulta({ id: 'otra' })]))).toBeNull();
    expect(miradaVigente(mirada, [])).toBeNull();
  });

  it('sin nada elegido no hay panel que mantener', () => {
    expect(miradaVigente(null, grupos([fila]))).toBeNull();
  });

  it('la busca en todos los grupos, no solo en el primero', () => {
    const otros: GrupoConsultas[] = [
      { rubro: 'seco', titulo: 'Construcción en seco', consultas: [] },
      ...grupos([fila]),
    ];
    expect(miradaVigente(mirada, otros)).toBe(mirada);
  });
});

/**
 * Qué se resalta en una consulta de **dato de obra** (§5.2).
 *
 * Nace sin fuentes propias y con razón: el hecho —la altura de local de PB— no
 * se leyó en ninguna lámina, así que no hay bbox honesto que citar (P1 no se
 * cumple citando cualquier cosa). Lo que sí existe es dónde está dibujado cada
 * afectado, y es lo único que el arquitecto puede mirar para contestarla.
 */
describe('fuentesDeAfectadas', () => {
  const T1: FuenteVista = { laminaId: A01, bbox: HUECO };
  const T2: FuenteVista = { laminaId: A01, bbox: OTRO_HUECO };
  const T3: FuenteVista = { laminaId: DET00, bbox: FILA_PLANILLA };

  const PLANO = new Map<string, FuenteVista[]>([
    ['t1', [T1]],
    ['t2', [T2]],
    ['t3', [T3]],
  ]);

  it('junta las fuentes de los afectados en el orden en que se los nombra', () => {
    expect(fuentesDeAfectadas(['t1', 't2', 't3'], PLANO)).toEqual([T1, T2, T3]);
  });

  it('no repite un mismo lámina+bbox aunque dos afectados lo compartan', () => {
    const compartido = new Map<string, FuenteVista[]>([
      ['t1', [T1]],
      ['t2', [{ laminaId: A01, bbox: HUECO }]],
    ]);

    expect(fuentesDeAfectadas(['t1', 't2'], compartido)).toEqual([T1]);
  });

  it('una entidad que ya no está no rompe: se saltea', () => {
    expect(fuentesDeAfectadas(['t1', 'borrada'], PLANO)).toEqual([T1]);
  });

  it('sin afectados no hay nada que resaltar', () => {
    expect(fuentesDeAfectadas([], PLANO)).toEqual([]);
  });
});
