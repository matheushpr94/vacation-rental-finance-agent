/**
 * Regras de negócio do dinheiro (funções puras sobre o store).
 *
 *   valor bruto  = o que o hóspede paga
 *   comissão     = parte da gestora (não é custo do proprietário; nunca entra como débito)
 *   valor líquido = o que é do proprietário (receita de verdade)
 *
 *   saldo contábil   = Σ créditos − Σ débitos ativos (débitos já reembolsados ficam fora)
 *   saldo confirmado = contábil + parcelas já pagas pelo hóspede e ainda não repassadas
 *   saldo projetado  = contábil + tudo que falta repassar das reservas ativas
 *
 * Armadilha que já aconteceu em produção: somar "parcelas pagas" em cima do contábil quando o repasse
 * já caiu como crédito conta o mesmo dinheiro duas vezes. Por isso o "a receber" é sempre
 * líquido − capturado, nunca Σ parcelas pagas.
 */
import { round2, ym, addMonths } from './util.js';

export const ACTIVE = ['confirmed', 'completed'];

export function accountingBalance(store) {
  let credits = 0, debits = 0, reimbursed = 0, nc = 0, nd = 0;
  for (const t of store.transactions) {
    if (t.type === 'credit') { credits += t.amount; nc++; } else if (t.reimbursement_status === 'paid') reimbursed += t.amount;
    else { debits += t.amount; nd++; }
  }
  return { credits: round2(credits), debits: round2(debits), reimbursed_excluded: round2(reimbursed), credits_count: nc, debits_count: nd, balance: round2(credits - debits) };
}

export function receivables(store) {
  let paidNotCaptured = 0, notPaid = 0;
  const byReservation = [];
  for (const r of store.reservations.filter((x) => ACTIVE.includes(x.status) && x.net_value > 0)) {
    const sched = store.payment_schedule.filter((p) => p.reservation_id === r.id);
    const captured = r.captured_total || 0;
    const outstanding = round2(Math.max(0, r.net_value - captured));
    const paid = sched.filter((p) => p.paid).reduce((s, p) => s + p.amount, 0);
    const pnc = round2(Math.min(outstanding, Math.max(0, paid - captured)));
    paidNotCaptured += pnc;
    notPaid += outstanding - pnc;
    if (outstanding > 0.01) byReservation.push({ code: r.code, check_in: r.check_in, net_value: r.net_value, captured: round2(captured), outstanding });
  }
  return { paid_not_captured: round2(paidNotCaptured), not_paid: round2(notPaid), total: round2(paidNotCaptured + notPaid), by_reservation: byReservation };
}

export function balances(store) {
  const acc = accountingBalance(store);
  const rec = receivables(store);
  return {
    as_of: store.meta?.as_of,
    accounting: acc.balance,
    confirmed: round2(acc.balance + rec.paid_not_captured),
    projected: round2(acc.balance + rec.total),
    detail: { ...acc, receivable_paid_not_captured: rec.paid_not_captured, receivable_not_paid: rec.not_paid, receivable_total: rec.total, reservations_with_outstanding: rec.by_reservation.length },
  };
}

export function monthlyBreakdown(store, { months = 6, asOf = store.meta?.as_of } = {}) {
  const from = addMonths(ym(asOf), -months);
  const out = {};
  for (const t of store.transactions) {
    const m = ym(t.date);
    if (m < from || t.date > asOf) continue;
    const row = (out[m] ||= { credits: 0, debits: 0, net: 0, count: 0, categories: {} });
    row.count++;
    if (t.type === 'credit') row.credits += t.amount; else { row.debits += t.amount; row.categories[t.category] = (row.categories[t.category] || 0) + t.amount; }
  }
  for (const r of Object.values(out)) {
    r.credits = round2(r.credits); r.debits = round2(r.debits); r.net = round2(r.credits - r.debits);
    for (const k of Object.keys(r.categories)) r.categories[k] = round2(r.categories[k]);
  }
  return Object.fromEntries(Object.entries(out).sort());
}

export function queryTransactions(store, { from, to, type, category, search, limit = 50 } = {}) {
  const s = search ? search.toLowerCase() : null;
  const rows = store.transactions.filter((t) => (!from || t.date >= from) && (!to || t.date <= to) && (!type || t.type === type)
    && (!category || t.category === category) && (!s || t.description.toLowerCase().includes(s)))
    .sort((a, b) => b.date.localeCompare(a.date));
  const sum = round2(rows.reduce((x, t) => x + (t.type === 'credit' ? t.amount : -t.amount), 0));
  return { total_records: rows.length, returned: Math.min(limit, rows.length), truncated: rows.length > limit, net_sum_all_records: sum, transactions: rows.slice(0, limit) };
}
