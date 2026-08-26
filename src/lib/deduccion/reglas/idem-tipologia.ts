/**
 * Regla `idem_tipologia` (§11 PRD) — factor 0,75, la más floja de las cinco.
 *
 * Es el "ídem V1" del plano: la abertura sin acotar cuyo tag es una **variante**
 * del de otra —V2a de V2— y comparte tipología toma sus medidas.
 *
 * El factor bajo no es casualidad: el prefijo del tag es una convención de
 * dibujo, no un dato del expediente. Con 0,75 la regla apenas pasa el umbral de
 * 0,7, así que solo propone sobre lecturas muy limpias; cualquier duda del
 * análisis la deja afuera y el hueco va a consulta, que es lo correcto.
 *
 * Tres guardas contra el falso positivo:
 *   - la tipología tiene que ser la misma (una P1 puerta jamás toma de una V2 ventana);
 *   - el sufijo no puede empezar con dígito (V21 no es una variante de V2);
 *   - si dos candidatas dan valores distintos, no se elige ninguna.
 */
import type { EntidadPersistida } from '@/lib/computo/engine';
import type { CandidatoDeduccion, ContextoDeduccion, SalidaRegla } from '@/lib/deduccion/motor';
import { describirValor, etiquetaCampo, leerCampo } from '@/lib/deduccion/motor';
import { tagDeAbertura } from '@/lib/deduccion/reglas/planilla-plano';
import { leerTexto } from '@/lib/hallazgos/taxonomia';

const CAMPOS = ['anchoM', 'altoM'] as const;

/** "V2a" es variante de "V2"; "V21" no —el sufijo numérico es otro tag—. */
export function esVarianteDe(tagVariante: string, tagBase: string): boolean {
  if (tagVariante.length <= tagBase.length) return false;
  if (!tagVariante.startsWith(tagBase)) return false;
  return !/^\d/.test(tagVariante.slice(tagBase.length));
}

function tipologiaDe(entidad: EntidadPersistida): string | null {
  return leerTexto(entidad, 'tipologia')?.toLocaleLowerCase('es-AR') ?? null;
}

export function deducirIdemTipologia(
  entidades: readonly EntidadPersistida[],
  ctx: ContextoDeduccion,
): SalidaRegla {
  const aberturas = entidades.filter((entidad) => entidad.tipo === 'abertura');
  const candidatos: CandidatoDeduccion[] = [];

  for (const destino of aberturas) {
    const tag = tagDeAbertura(destino);
    const tipologia = tipologiaDe(destino);
    if (tag === null || tipologia === null) continue;

    for (const campo of CAMPOS) {
      if (leerCampo(destino, campo) !== null) continue;

      const bases = aberturas.filter((otra) => {
        const tagOtra = tagDeAbertura(otra);
        return (
          otra.id !== destino.id &&
          tagOtra !== null &&
          esVarianteDe(tag, tagOtra) &&
          tipologiaDe(otra) === tipologia &&
          leerCampo(otra, campo) !== null
        );
      });
      if (bases.length === 0) continue;

      // Entre "V2a-1 ídem V2a" y "V2a-1 ídem V2", manda la tipología más cercana.
      const masLargo = Math.max(...bases.map((base) => tagDeAbertura(base)!.length));
      const elegidas = bases.filter((base) => tagDeAbertura(base)!.length === masLargo);

      const valores = new Set(elegidas.map((base) => leerCampo(base, campo)!));
      if (valores.size > 1) continue; // dos "ídem" que no coinciden: no elijo yo

      const fuente = elegidas[0]!;
      const valor = leerCampo(fuente, campo)!;

      candidatos.push({
        destino,
        campo,
        valor,
        aportes: [destino, ...elegidas],
        explicacion:
          `${tag} no está acotada y comparte tipología (${tipologia}) con ${tagDeAbertura(fuente)} ` +
          `(lámina ${ctx.codigoLamina(fuente)}): toma su ${etiquetaCampo(campo)} ${describirValor(campo, valor)}.`,
      });
    }
  }

  return { candidatos, inconsistencias: [] };
}
