#!/usr/bin/env node
/**
 * CLI de demonstração (substitui a interface de chat da produção).
 *   node src/cli.js saldo | mes [n] | anomalias | previsao [n] | conciliar YYYY-MM | revisao
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadStore } from './lib/store.js';
import { balances, monthlyBreakdown } from './lib/finance.js';
import { detectAnomalies } from './lib/anomalies.js';
import { forecast } from './lib/forecast.js';
import { reconcile, parseCsv } from './lib/reconcile.js';
import { reviewQueue } from './lib/categorizer.js';
import { brl } from './lib/util.js';

const [cmd = 'saldo', arg] = process.argv.slice(2);
const s = loadStore();
if (!s.meta) { console.error('Banco vazio. Rode antes: npm run generate && npm run sync'); process.exit(1); }

switch (cmd) {
  case 'saldo': {
    const b = balances(s);
    console.log(`Casa Exemplo, posição em ${b.as_of}`);
    console.log(`  Saldo contábil   ${brl(b.accounting).padStart(16)}   créditos − débitos ativos`);
    console.log(`  Saldo confirmado ${brl(b.confirmed).padStart(16)}   + pago pelo hóspede, ainda não repassado`);
    console.log(`  Saldo projetado  ${brl(b.projected).padStart(16)}   + parcelas a receber (${b.detail.reservations_with_outstanding} reservas)`);
    break;
  }
  case 'mes':
    for (const [m, r] of Object.entries(monthlyBreakdown(s, { months: Number(arg) || 6 }))) console.log(`${m}  receita ${brl(r.credits).padStart(14)}  despesa ${brl(r.debits).padStart(14)}  resultado ${brl(r.net).padStart(14)}`);
    break;
  case 'anomalias':
    for (const a of detectAnomalies(s.transactions, { asOf: s.meta.as_of })) {
      console.log(a.kind === 'monthly'
        ? `${a.direction === 'alta' ? '▲' : '▼'} ${a.category} em ${a.month}: ${brl(a.value)} vs mediana ${brl(a.median)} (${a.deviation_pct > 0 ? '+' : ''}${a.deviation_pct}%)`
        : `⚠ ${a.description} (${a.date}): ${brl(a.value)} vs mediana ${brl(a.median)} em ${a.category} (+${a.deviation_pct}%)`);
    }
    break;
  case 'previsao': {
    const f = forecast(s, { months: Number(arg) || 6 });
    console.log(`Saldo inicial ${brl(f.start_balance)}`);
    for (const m of f.months) console.log(`${m.month}  receita ${brl(m.revenue_pipeline).padStart(13)}  despesa ${brl(m.expense_estimate).padStart(13)}  saldo ${brl(m.balance).padStart(14)}  (${m.expense_basis})`);
    break;
  }
  case 'conciliar': {
    const month = arg || '2026-09';
    const st = JSON.parse(fs.readFileSync(path.resolve('data/pms/statements.json'), 'utf-8'))[month];
    const rep = parseCsv(fs.readFileSync(path.resolve(`data/manager-reports/relatorio-gestora-${month}.csv`), 'utf-8'));
    const r = reconcile(st.debits, rep);
    console.log(`Conciliação ${month}:`, r.summary);
    for (const x of r.rows.filter((y) => y.status !== 'ok')) console.log(`  ${x.status.padEnd(20)} ${x.date} ${x.description.padEnd(40)} pms=${x.pms ?? '-'} relatório=${x.report ?? '-'}`);
    break;
  }
  case 'revisao':
    for (const l of reviewQueue(s)) console.log(`[${l.confidence}] ${l.description} → ${l.assigned_category}`);
    break;
  default:
    console.error('comandos: saldo | mes [n] | anomalias | previsao [n] | conciliar YYYY-MM | revisao');
    process.exit(1);
}
