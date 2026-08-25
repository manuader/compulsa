/**
 * Auditoría (CLAUDE.md §4): toda escritura hecha por el pipeline o por un agente
 * —y toda acción sensible del usuario— deja un registro con actor y diff.
 */
import { getDb } from '@/db/client';
import { auditoria, type ActorTipo } from '@/db/schema';

export interface EntradaAuditoria {
  /** Ausente en acciones de plataforma (registro de estudio, login…). */
  obraId?: string;
  actorTipo: ActorTipo;
  /** Mail del usuario, o nombre del agente ('pipeline', 'analisis-claude'…). */
  actorNombre: string;
  /** Verbo en snake_case: 'computo_recalculado', 'hallazgo_respondido', 'analisis_llm'. */
  accion: string;
  /** Qué se tocó, en formato libre pero estable: 'computo_items:<claveItem>'. */
  targetRef?: string;
  /** Antes/después de la mutación, o metadata de la acción. */
  diff?: Record<string, unknown>;
}

export async function registrarAuditoria(entrada: EntradaAuditoria): Promise<void> {
  const db = await getDb();
  await db.insert(auditoria).values({
    obraId: entrada.obraId ?? null,
    actorTipo: entrada.actorTipo,
    actorNombre: entrada.actorNombre,
    accion: entrada.accion,
    targetRef: entrada.targetRef ?? null,
    diffJson: entrada.diff ?? null,
  });
}
