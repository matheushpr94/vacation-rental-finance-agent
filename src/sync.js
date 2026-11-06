#!/usr/bin/env node
/**
 * Sync: PMS → store. Em produção roda 2x/dia; aqui um "replay" percorre o histórico sintético a
 * cada 15 dias, puxando janelas que se sobrepõem (como o cron real faz). É isso que exercita o dedup:
 * a mesma reserva e o mesmo lançamento chegam várias vezes, às vezes com id diferente.
 *
 * Uso: node src/sync.js [--as-of=YYYY-MM-DD] [--step-days=15] [--fresh]
 * LLM: com ANTHROPIC_API_KEY usa o SDK; sem chave, só o fallback 50/50 (nada sai da máquina).
 */
import { pmsClient } from './pms/client.js';
import { loadStore, saveStore, emptyStore, uuidFrom, audit, trackRun, DEFAULT_DB } from './lib/store.js';
import { findDuplicate, transactionExternalId, isPlaceholderName } from './lib/dedup.js';
import { categorizeWithLog } from './lib/categorizer.js';
import { parseObservation } from './lib/parse-observation.js';
import { createAnthropicLLM } from './lib/llm.js';
import { addDays, ym, addMonths, round2 } from './lib/util.js';

const STATUS = (v, asOf) => (v.status === 'cancelled' ? 'cancelled' : v.status === 'blocked' ? 'blocked' : v.check_out < asOf ? 'completed' : 'confirmed');

function toRow(v, asOf) {
  return {
    external_id: v.id, code: v.code, guest_name: v.guest_name, check_in: v.check_in, check_out: v.check_out,
    nights: v.nights, gross_value: v.gross_value, commission: v.commission, net_value: v.net_value,
    channel: v.channel, status: STATUS(v, asOf), observation: v.observation || '', paid_total: v.paid_total,
  };
}

export async function syncReservations(store, pms, asOf, { llm = null, stats, dedup = findDuplicate }) {
  const list = await pms.reservations({ asOf });
  for (const v of list) {
    const row = toRow(v, asOf);
    const d = dedup(store.reservations, row);
    if (d.duplicate || d.should_update) {
      const m = d.match;
      stats.dedup[`criterio_${d.criterion}`] = (stats.dedup[`criterio_${d.criterion}`] || 0) + 1;
      if (m.external_id !== row.external_id && !m.aliases.includes(row.external_id)) {
        m.aliases.push(row.external_id);
        audit(store, { table: 'reservations', record_id: m.id, action: 'alias', new_data: { external_id: row.external_id, criterion: d.criterion, reason: d.reason }, source: 'sync', at: asOf });
      }
      if (d.should_update && !isPlaceholderName(row.guest_name) && row.guest_name !== m.guest_name) m.guest_name = row.guest_name;
      if (Math.abs(row.net_value - m.net_value) > 1 && !m.value_divergence) {
        // valor mudou na PMS depois do checkout: não sobrescreve, sinaliza para revisão humana
        m.value_divergence = { pms_value: row.net_value, seen_at: asOf };
        stats.value_divergences++;
      }
      m.status = row.status;
      m.paid_total = Math.max(m.paid_total || 0, row.paid_total || 0);
      continue;
    }
    if (row.status === 'cancelled' && !store.reservations.some((r) => r.code === row.code)) continue; // nunca vista ativa: ignora
    const id = uuidFrom(`res:${row.external_id}`);
    store.reservations.push({ id, ...row, aliases: [], source: 'sync', created_at: asOf });
    stats.reservations_inserted++;
    audit(store, { table: 'reservations', record_id: id, action: 'insert', new_data: { code: row.code }, source: 'sync', at: asOf });
    if (['confirmed', 'completed'].includes(row.status) && row.net_value > 0) {
      const r = await parseObservation({ observation: row.observation, net_value: row.net_value, check_in: row.check_in }, { llm });
      stats.parser[r.source]++;
      r.installments.forEach((p) => store.payment_schedule.push({
        id: uuidFrom(`ps:${id}:${p.installment_number}`), reservation_id: id, ...p, paid: false, paid_date: null, captured: false, parser_source: r.source,
      }));
    }
  }
}

/** Marca parcelas pagas a partir do total pago informado pela PMS (em ordem). */
export function applyPayments(store, asOf) {
  for (const r of store.reservations) {
    let left = (r.paid_total || 0) + 1;
    for (const p of store.payment_schedule.filter((x) => x.reservation_id === r.id).sort((a, b) => a.installment_number - b.installment_number)) {
      if (r.status === 'cancelled') break;
      if (!p.paid && p.amount <= left) { p.paid = true; p.paid_date = asOf; }
      if (p.paid) left -= p.amount;
    }
  }
}

/** Créditos "Repasse reserva CEnnn parc. N" → parcelas capturadas (o dinheiro chegou ao caixa). */
export function applyCaptures(store) {
  const capturedBy = {};
  for (const t of store.transactions) {
    const m = t.type === 'credit' && t.description.match(/reserva\s+(CE\d+)/i);
    if (m) capturedBy[m[1]] = (capturedBy[m[1]] || 0) + t.amount;
  }
  for (const r of store.reservations) {
    r.captured_total = round2(capturedBy[r.code] || 0);
    let left = r.captured_total + 1;
    for (const p of store.payment_schedule.filter((x) => x.reservation_id === r.id).sort((a, b) => a.installment_number - b.installment_number)) {
      p.captured = p.amount <= left;
      if (p.captured) left -= p.amount;
    }
  }
}

export async function syncStatements(store, pms, asOf, { stats }) {
  // janela: os 2 últimos meses fechados (sobreposição proposital entre execuções)
  const last = addMonths(ym(asOf), -1);
  for (const month of [addMonths(last, -1), last]) {
    const st = await pms.statement({ month });
    for (const [type, items] of [['debit', st.debits], ['credit', st.credits]]) {
      for (const x of items) {
        if (x.date >= asOf) continue;
        const external_id = transactionExternalId({ type, date: x.date, description: x.description, amount: x.value });
        // dedup de transação em 2 critérios: id determinístico; depois data+valor+início da descrição
        const dupe = store.transactions.find((t) => t.external_id === external_id)
          || store.transactions.find((t) => t.type === type && t.date === x.date && Math.abs(t.amount - x.value) < 0.01 && t.description.slice(0, 20).toLowerCase() === x.description.slice(0, 20).toLowerCase());
        if (dupe) { stats.tx_skipped++; continue; }
        const id = uuidFrom(`tx:${external_id}`);
        const category = type === 'credit' ? 'revenue' : categorizeWithLog(store, x.description, id).category;
        store.transactions.push({ id, external_id, date: x.date, description: x.description, amount: x.value, type, category, source: 'sync', is_manual: false, reimbursement_status: null, created_at: asOf });
        stats.tx_inserted++;
      }
    }
  }
}

export async function syncOnce(store, pms, asOf, opts = {}) {
  const run = trackRun(store, 'sync', asOf);
  const stats = opts.stats;
  try {
    await syncReservations(store, pms, asOf, { ...opts, stats });
    applyPayments(store, asOf);
    await syncStatements(store, pms, asOf, { stats });
    applyCaptures(store);
    run.finish(stats.reservations_inserted + stats.tx_inserted);
  } catch (e) {
    run.fail(e);
    throw e;
  }
}

export function newStats() {
  return { runs: 0, reservations_inserted: 0, tx_inserted: 0, tx_skipped: 0, value_divergences: 0, dedup: {}, parser: { llm: 0, fallback: 0 } };
}

/** Replay do histórico: de `from` até `asOf`, passo de `stepDays`. */
export async function replay({ store = emptyStore(), pms = pmsClient(), from, asOf, stepDays = 15, llm = null, findDuplicate: dedup = findDuplicate } = {}) {
  const meta = await pms.meta();
  asOf ||= meta.as_of;
  from ||= meta.history_start || addDays(asOf, -365);
  const stats = newStats();
  const dates = [];
  for (let d = from; d < asOf; d = addDays(d, stepDays)) dates.push(d);
  dates.push(asOf);
  for (const d of dates) { await syncOnce(store, pms, d, { llm, stats, dedup }); stats.runs++; }
  store.meta = { as_of: asOf, property: meta.property };
  return { store, stats };
}

async function main() {
  const arg = (k, def) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
  const llm = await createAnthropicLLM();
  const { store, stats } = await replay({ asOf: arg('as-of'), stepDays: Number(arg('step-days', 15)), llm });
  saveStore(store);
  console.log(JSON.stringify({ db: DEFAULT_DB.replace(process.cwd() + '/', ''), llm: llm ? 'anthropic' : 'desligado (fallback 50/50)', ...stats,
    totals: { reservations: store.reservations.length, transactions: store.transactions.length, schedule: store.payment_schedule.length } }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
