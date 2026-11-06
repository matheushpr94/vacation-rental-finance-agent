#!/usr/bin/env node
/**
 * Eval de dinheiro: o sync + as regras de saldo reproduzem a "verdade" calculada direto dos
 * arquivos da PMS fake (sem passar pelo código do sync)? Também checa anomalias plantadas e a
 * validação do lançamento manual (a única escrita do MCP).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from '../src/sync.js';
import { emptyStore } from '../src/lib/store.js';
import { balances as balancesImpl } from '../src/lib/finance.js';
import { detectAnomalies } from '../src/lib/anomalies.js';
import { createManualEntry } from '../src/lib/manual-entry.js';
import { round2 } from '../src/lib/util.js';
import { check, summarize, printReport, isMain } from './harness.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pms', f), 'utf-8'));

/** Verdade independente, calculada só a partir dos arquivos gerados. */
export function groundTruth() {
  const meta = read('meta.json');
  const st = read('statements.json');
  const res = read('reservations.json');
  const seen = new Set();
  let credits = 0, debits = 0;
  for (const m of Object.values(st)) {
    for (const [kind, list] of [['c', m.credits], ['d', m.debits]]) {
      for (const x of list) {
        const k = `${kind}|${x.date}|${x.description}|${x.value}`;
        if (x.date >= meta.as_of || seen.has(k)) continue;
        seen.add(k);
        if (kind === 'c') credits += x.value; else debits += x.value;
      }
    }
  }
  const accounting = round2(credits - debits);
  let outstanding = 0, paidNotCaptured = 0;
  for (const r of res.filter((x) => x.status === 'booked' && x.booked_at <= meta.as_of && x.net_value > 0)) {
    const captured = r.truth_schedule.filter((p) => p.captured_on).reduce((s, p) => s + p.amount, 0);
    const paid = r.truth_schedule.filter((p) => p.paid_date && p.paid_date <= meta.as_of).reduce((s, p) => s + p.amount, 0);
    outstanding += r.net_value - captured;
    paidNotCaptured += Math.max(0, paid - captured);
  }
  return { as_of: meta.as_of, accounting, confirmed: round2(accounting + paidNotCaptured), projected: round2(accounting + outstanding) };
}

export async function run({ balances = balancesImpl } = {}) {
  const res = [];
  const truth = groundTruth();
  const { store } = await replay({ store: emptyStore() });
  const b = balances(store);
  for (const k of ['accounting', 'confirmed', 'projected']) check(res, `saldo ${k} = verdade`, Math.abs(b[k] - truth[k]) <= 0.05, `calculado ${b[k]} vs verdade ${truth[k]}`);
  check(res, 'projetado ≥ confirmado ≥ contábil', b.projected >= b.confirmed && b.confirmed >= b.accounting);

  const an = detectAnomalies(store.transactions, { asOf: store.meta.as_of });
  check(res, 'anomalia plantada: lançamento de manutenção', an.some((a) => a.kind === 'transaction' && /bomba/i.test(a.description)));
  check(res, 'anomalia plantada: energia de set/2026', an.some((a) => a.kind === 'monthly' && a.category === 'electricity' && a.month === '2026-09'));
  check(res, 'sem falso positivo em conta fixa (internet)', !an.some((a) => a.category === 'internet'));

  const s = { ...store, transactions: [...store.transactions], audit_log: [...store.audit_log] };
  const okIn = { date: '2026-10-20', description: 'Conserto portão elétrico', amount: 350, type: 'debit', reason: 'pago em dinheiro, sem nota na PMS' };
  const cases = [
    ['sem confirmação → só prévia', okIn, 'pending_confirmation'],
    ['confirmado → grava', { ...okIn, confirmed: true }, 'created'],
    ['repetido → duplicata', { ...okIn, confirmed: true }, 'rejected'],
    ['data futura', { ...okIn, date: '2027-01-10', confirmed: true }, 'rejected'],
    ['valor negativo', { ...okIn, amount: -350, confirmed: true }, 'rejected'],
    ['3 casas decimais', { ...okIn, amount: 350.123, confirmed: true }, 'rejected'],
    ['categoria inventada', { ...okIn, category: 'lazer', confirmed: true }, 'rejected'],
    ['sem motivo', { ...okIn, reason: '', confirmed: true }, 'rejected'],
    ['data inexistente', { ...okIn, date: '2026-02-30', confirmed: true }, 'rejected'],
    ['crédito com categoria de despesa', { ...okIn, type: 'credit', category: 'maintenance', confirmed: true }, 'rejected'],
  ];
  for (const [label, input, exp] of cases) {
    const r = createManualEntry(s, input);
    check(res, `lançamento manual: ${label}`, r.status === exp, `veio ${r.status} ${r.errors ? r.errors.join('; ') : ''}`);
  }
  const created = s.transactions.filter((t) => t.is_manual);
  check(res, 'lançamento manual: auditado', created.length === 1 && s.audit_log.some((a) => a.record_id === created[0].id));
  return summarize('saldos, anomalias, escrita', res);
}

export const sabotaged = {
  // erro clássico: somar parcelas pagas por cima do contábil mesmo quando o repasse já entrou
  'double-counting de parcelas pagas': {
    balances: (store) => {
      const b = balancesImpl(store);
      const paid = store.payment_schedule.filter((p) => p.paid).reduce((s, p) => s + p.amount, 0);
      return { ...b, confirmed: round2(b.accounting + paid) };
    },
  },
};

if (isMain(import.meta.url)) process.exit(printReport(await run()) ? 0 : 1);
