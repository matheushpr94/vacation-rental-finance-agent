/**
 * Previsão de caixa simples e explicável (sem modelo treinado; o histórico é curto).
 *
 *  despesa do mês M  = mediana dos totais do mesmo mês-do-ano no histórico, se existir,
 *                      senão mediana dos últimos 6 meses fechados (pega a sazonalidade de energia,
 *                      13º, férias, IPTU)
 *  receita do mês M  = parcelas a receber com vencimento em M (pipeline real)
 *                      + parcelas sem prazo, alocadas no mês do check-in
 *  saldo             = parte do contábil e acumula
 *
 * Limitação declarada: não estima reservas que ainda não existem (só pipeline). É conservador.
 */
import { median, round2, addMonths, ym, monthKeyAgo } from './util.js';
import { accountingBalance, ACTIVE } from './finance.js';

export function forecast(store, { months = 6, asOf = store.meta?.as_of } = {}) {
  const monthlyDebits = {};
  for (const t of store.transactions) if (t.type === 'debit' && t.date < `${ym(asOf)}-01`) monthlyDebits[ym(t.date)] = (monthlyDebits[ym(t.date)] || 0) + t.amount;
  const recent = [];
  for (let i = 1; i <= 6; i++) if (monthlyDebits[monthKeyAgo(i, asOf)] != null) recent.push(monthlyDebits[monthKeyAgo(i, asOf)]);
  const baseline = median(recent);

  const pipeline = {};
  for (const r of store.reservations.filter((x) => ACTIVE.includes(x.status))) {
    let captured = r.captured_total || 0;
    for (const p of store.payment_schedule.filter((x) => x.reservation_id === r.id).sort((a, b) => a.installment_number - b.installment_number)) {
      if (captured >= p.amount - 1) { captured -= p.amount; continue; }
      const k = ym(p.due_date && p.due_date >= asOf ? p.due_date : (r.check_in >= asOf ? r.check_in : asOf));
      pipeline[k] = (pipeline[k] || 0) + p.amount;
    }
  }

  let bal = accountingBalance(store).balance;
  const rows = [];
  for (let i = 0; i < months; i++) {
    const k = addMonths(ym(asOf), i);
    const sameMonth = Object.entries(monthlyDebits).filter(([m]) => m.slice(5) === k.slice(5)).map(([, v]) => v);
    const expense = round2(sameMonth.length ? median(sameMonth) : baseline);
    const revenue = round2(pipeline[k] || 0);
    bal = round2(bal + revenue - expense);
    rows.push({ month: k, revenue_pipeline: revenue, expense_estimate: expense, expense_basis: sameMonth.length ? `mediana do mesmo mês (${sameMonth.length} ano(s))` : 'mediana 6 meses', net: round2(revenue - expense), balance: bal });
  }
  return { start_balance: accountingBalance(store).balance, months: rows };
}
