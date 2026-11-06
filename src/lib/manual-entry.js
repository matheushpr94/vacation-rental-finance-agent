/**
 * Lançamento manual com validação (é a única tool de escrita exposta pelo MCP).
 *
 * Contenção: o agente pode PROPOR, mas por padrão a escrita só acontece com `confirmed: true`
 * (modo "confirm"), que o humano dá depois de ver a prévia. Toda escrita grava source, motivo e
 * audit_log. Validação rejeita o que o modelo costuma errar: data no futuro, valor negativo ou com
 * mais de 2 casas, categoria inventada, duplicata do mesmo lançamento.
 */
import { z } from 'zod';
import { uuidFrom, audit } from './store.js';
import { categorize } from './categorizer.js';
import { round2 } from './util.js';

export const CATEGORIES = ['owner_payout', 'staff', 'hospitality', 'pool', 'gas', 'laundry', 'maintenance', 'electricity', 'water',
  'condominium', 'internet', 'taxes', 'professional_services', 'refund', 'supplies', 'revenue', 'other'];

export const manualEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data deve ser YYYY-MM-DD'),
  description: z.string().trim().min(3, 'descrição curta demais').max(120),
  amount: z.number().positive('valor deve ser positivo; use type para crédito/débito')
    .max(100_000, 'valor acima do limite de lançamento manual')
    .refine((v) => Math.abs(round2(v) - v) < 1e-9, 'no máximo 2 casas decimais'),
  type: z.enum(['credit', 'debit']),
  category: z.enum(CATEGORIES).optional(),
  reason: z.string().trim().min(5, 'motivo obrigatório (mín. 5 caracteres)'),
  confirmed: z.boolean().default(false),
});

export function createManualEntry(store, input, { asOf = store.meta?.as_of, writeMode = 'confirm' } = {}) {
  const parsed = manualEntrySchema.safeParse(input);
  if (!parsed.success) return { status: 'rejected', errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`) };
  const e = parsed.data;
  const errors = [];
  if (Number.isNaN(Date.parse(`${e.date}T00:00:00Z`)) || new Date(`${e.date}T00:00:00Z`).toISOString().slice(0, 10) !== e.date) errors.push('date: data inexistente');
  if (asOf && e.date > asOf) errors.push(`date: no futuro (hoje é ${asOf}); parcela futura não é lançamento`);
  if (e.type === 'credit' && e.category && e.category !== 'revenue') errors.push('category: crédito só pode ser revenue');
  if (errors.length) return { status: 'rejected', errors };

  const category = e.type === 'credit' ? 'revenue' : e.category || categorize(e.description).category;
  const dup = store.transactions.find((t) => t.date === e.date && t.type === e.type && Math.abs(t.amount - e.amount) < 0.01
    && t.description.slice(0, 15).toLowerCase() === e.description.slice(0, 15).toLowerCase());
  if (dup) return { status: 'rejected', errors: [`duplicata provável de ${dup.id} (${dup.date} ${dup.description})`] };

  const row = { date: e.date, description: e.description, amount: e.amount, type: e.type, category, source: 'agent', is_manual: true, reason: e.reason, reimbursement_status: null };
  if (writeMode === 'confirm' && !e.confirmed) {
    return { status: 'pending_confirmation', message: 'Prévia. Reenvie com confirmed=true depois que o humano aprovar.', preview: row };
  }
  const id = uuidFrom(`manual:${e.date}:${e.description}:${e.amount}:${store.transactions.length}`);
  store.transactions.push({ id, external_id: null, ...row, created_at: asOf });
  audit(store, { table: 'transactions', record_id: id, action: 'insert', new_data: row, source: 'agent', at: asOf });
  return { status: 'created', id, transaction: row };
}
