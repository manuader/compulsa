/**
 * Prueba de idioma de Jev: ¿entiende castellano rioplatense de obra?
 *
 * Es la pregunta que gatea todo el diseño de
 * `docs/superpowers/specs/2026-09-21-jev-analisis-y-computo-design.md`: la
 * documentación de TypeSafe dice que el idioma primario es el inglés y que los
 * demás "se manejan pero no igual de bien", y ninguna evaluación independiente
 * publicada probó castellano.
 *
 * Corre cada ítem DOS veces —una con la pregunta y los criterios en castellano,
 * otra con los mismos en inglés sobre el mismo estado en castellano— porque esa
 * es la mitigación que el diseño propone y hay que medirla, no suponerla.
 *
 *   node --env-file=.env.local scripts/probe-jev.mjs [--solo=material,mensaje]
 *
 * No usa node_modules: fetch es global desde Node 18.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MODELO = process.env.DECISION_MODEL ?? 'jev-1.13.0';
const CONCURRENCIA = 6;               // PriorBench midió 8 como punto de operación
const UMBRAL = 0.99;                  // el que el diseño pinnea, por la calibración no lineal
const PRECIO_MTOK_ENTRADA = 0.042;    // USD, salida gratis

const datos = JSON.parse(readFileSync(new URL('../tests/probes/jev-idioma.json', import.meta.url), 'utf8'));
const filtro = process.argv.find((a) => a.startsWith('--solo='))?.slice(7).split(',');
const items = filtro ? datos.items.filter((i) => filtro.includes(i.categoria)) : datos.items;

if (!process.env.TYPESAFE_API_KEY) {
  console.error('Falta TYPESAFE_API_KEY. Corré con: node --env-file=.env.local scripts/probe-jev.mjs');
  process.exit(2);
}

/** Arma la pregunta tipada de un ítem en el idioma pedido. */
function pregunta(item, idioma) {
  const cat = datos.categorias[item.categoria];
  const instructions = idioma === 'es' ? cat.pregunta_es : cat.pregunta_en;

  if (cat.tipo === 'noul') {
    return { type: 'noul', instructions, criteria: idioma === 'es' ? cat.criteria_es : cat.criteria_en };
  }
  if (cat.tipo === 'choice') {
    return { type: 'choice', instructions, criteria: idioma === 'es' ? cat.criteria_es : cat.criteria_en };
  }
  // choice_dinamico: las opciones son los candidatos que el código encontró, y
  // la descripción de cada una es su propio texto. Jev elige un id; el valor lo
  // copia nuestro código. Es el patrón find + pick.
  const criteria = {};
  for (const id of item.opciones) {
    const fuente = item.state.fila?.celdas ?? item.state.pedido;
    const opcion = fuente.find((c) => c.id === id);
    criteria[id] = idioma === 'es' ? `La opción que dice: ${opcion.texto}` : `The option reading: ${opcion.texto}`;
  }
  criteria[cat.opcion_ninguno] = idioma === 'es' ? cat.criteria_ninguno_es : cat.criteria_ninguno_en;
  return { type: 'choice', instructions, criteria };
}

async function consultar(item, idioma) {
  const cuerpo = { state: item.state, model: MODELO, questions: { q: pregunta(item, idioma) } };
  const t0 = Date.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status} (${item.id}/${idioma}): ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const a = json.answers.q;

  // Un noul no trae `confidence`: la distancia a 0,5 es su equivalente.
  const [respuesta, confianza] =
    a.type === 'noul' ? [a.noul > 0.5, Math.abs(a.noul - 0.5) * 2] : [a.choice, a.confidence];

  return { id: item.id, categoria: item.categoria, idioma, ms, respuesta, confianza,
           ok: respuesta === item.esperado, esperado: item.esperado, dificil: item.dificil === true,
           tokens: json.usage.input_tokens, modelo: json.model };
}

/** Pool con cap, preservando el orden. Mismo criterio que `pipeline/pool.ts`. */
async function enParalelo(tareas, cap) {
  const salida = new Array(tareas.length);
  let siguiente = 0;
  await Promise.all(
    Array.from({ length: Math.min(cap, tareas.length) }, async () => {
      while (siguiente < tareas.length) {
        const i = siguiente++;
        try { salida[i] = await tareas[i](); }
        catch (e) { salida[i] = { error: String(e.message ?? e) }; }
      }
    }),
  );
  return salida;
}

const pct = (n, d) => (d === 0 ? '  — ' : `${((100 * n) / d).toFixed(1).padStart(5)}%`);

function tabla(resultados, idioma) {
  const suyos = resultados.filter((r) => r.idioma === idioma && !r.error);
  const cats = [...new Set(suyos.map((r) => r.categoria))];
  const filas = cats.map((c) => {
    const rs = suyos.filter((r) => r.categoria === c);
    const claros = rs.filter((r) => !r.dificil);
    const altos = rs.filter((r) => r.confianza >= UMBRAL);
    return { cat: c, n: rs.length,
             todos: pct(rs.filter((r) => r.ok).length, rs.length),
             claros: pct(claros.filter((r) => r.ok).length, claros.length),
             gate: `${pct(altos.filter((r) => r.ok).length, altos.length)} (${altos.length}/${rs.length})` };
  });
  console.log(`\n### criterios en ${idioma === 'es' ? 'CASTELLANO' : 'INGLÉS'} (el estado siempre en castellano)`);
  console.log('categoría       n   todos  sin difíciles   con confianza >= 0,99');
  for (const f of filas) {
    console.log(`${f.cat.padEnd(14)} ${String(f.n).padStart(2)}  ${f.todos}   ${f.claros}         ${f.gate}`);
  }
  const claros = suyos.filter((r) => !r.dificil);
  const altos = suyos.filter((r) => r.confianza >= UMBRAL);
  console.log(`${'TOTAL'.padEnd(14)} ${String(suyos.length).padStart(2)}  ${pct(suyos.filter((r) => r.ok).length, suyos.length)}   ${pct(claros.filter((r) => r.ok).length, claros.length)}         ${pct(altos.filter((r) => r.ok).length, altos.length)} (${altos.length}/${suyos.length})`);
  return suyos;
}

const tareas = [];
for (const item of items) for (const idioma of ['es', 'en']) tareas.push(() => consultar(item, idioma));

console.log(`Modelo: ${MODELO} · ${items.length} ítems × 2 idiomas = ${tareas.length} requests · cap ${CONCURRENCIA}\n`);
const t0 = Date.now();
const resultados = await enParalelo(tareas, CONCURRENCIA);
const segundos = (Date.now() - t0) / 1000;

const errores = resultados.filter((r) => r.error);
if (errores.length) {
  console.log(`\n${errores.length} requests fallaron. Primera: ${errores[0].error}\n`);
  if (errores.length === resultados.length) process.exit(1);
}

const es = tabla(resultados, 'es');
const en = tabla(resultados, 'en');

// Dónde no coinciden el esperado y la respuesta: la lista para revisar a mano,
// porque una etiqueta mal escrita por mí es indistinguible de un error del modelo.
console.log('\n### fallados (revisá la etiqueta antes de culpar al modelo)');
for (const r of [...es, ...en].filter((r) => !r.ok)) {
  const item = items.find((i) => i.id === r.id);
  console.log(`  ${r.id}/${r.idioma}${r.dificil ? ' (difícil)' : ''}: esperaba ${JSON.stringify(r.esperado)}, dijo ${JSON.stringify(r.respuesta)} con confianza ${r.confianza.toFixed(2)} — ${JSON.stringify(item.state).slice(0, 110)}`);
}

const ok = resultados.filter((r) => !r.error);
const latencias = ok.map((r) => r.ms).sort((a, b) => a - b);
const tokens = ok.reduce((s, r) => s + r.tokens, 0);
console.log(`\n### costo y latencia (desde esta máquina, en Argentina)`);
console.log(`  latencia  p50 ${latencias[Math.floor(latencias.length * 0.5)]} ms · p95 ${latencias[Math.floor(latencias.length * 0.95)]} ms · máx ${latencias.at(-1)} ms`);
console.log(`  corrida   ${tareas.length} requests en ${segundos.toFixed(1)} s`);
console.log(`  tokens    ${tokens} de entrada · USD ${((tokens / 1e6) * PRECIO_MTOK_ENTRADA).toFixed(6)}`);
console.log(`  modelo    ${ok[0]?.modelo ?? '?'} (el que contestó)`);

writeFileSync(new URL('../tests/probes/jev-idioma-resultados.json', import.meta.url),
  JSON.stringify({ fecha: new Date().toISOString(), modelo: MODELO, resultados }, null, 2));
console.log('\nCrudo en tests/probes/jev-idioma-resultados.json');
