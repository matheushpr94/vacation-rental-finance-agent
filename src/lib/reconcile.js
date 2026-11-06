/**
 * Conciliação: relatório manual da gestora (CSV) × extrato da PMS (fonte da verdade).
 * Foi esta comparação que mostrou que o relatório mensal omitia lançamentos.
 *
 * Casamento guloso por (data, valor) com tolerância de centavos e, em seguida, por descrição
 * parecida + valor no mesmo mês (data digitada errada). Classifica cada linha em:
 *   ok | valor_diferente | falta_no_relatorio | so_no_relatorio (inclui duplicados)
 */
import { removeAccents } from './categorizer.js';
import { round2 } from './util.js';

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(',');
  return lines.map((l) => {
    const cells = l.match(/("([^"]*)"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    const o = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    return { date: o.data, description: o.descricao, value: Number(o.valor) };
  });
}

const key = (s) => removeAccents(String(s).toLowerCase()).replace(/^\d+\.\s*/, '').replace(/[^a-z0-9]/g, '').slice(0, 16);

export function reconcile(pmsDebits, reportRows) {
  const left = pmsDebits.map((x, i) => ({ ...x, _i: i }));
  const right = reportRows.map((x, i) => ({ ...x, _i: i }));
  const usedR = new Set();
  const out = [];
  // passe 1: mesma data e mesmo valor
  for (const p of left) {
    const r = right.find((x) => !usedR.has(x._i) && x.date === p.date && Math.abs(x.value - p.value) < 0.02);
    if (r) { usedR.add(r._i); p._m = true; out.push({ status: 'ok', date: p.date, description: p.description, pms: p.value, report: r.value }); }
  }
  // passe 2: mesma descrição (e mesmo mês), valor diferente
  for (const p of left.filter((x) => !x._m)) {
    const r = right.find((x) => !usedR.has(x._i) && x.date.slice(0, 7) === p.date.slice(0, 7) && key(x.description) === key(p.description));
    if (r) { usedR.add(r._i); p._m = true; out.push({ status: 'valor_diferente', date: p.date, description: p.description, pms: p.value, report: r.value, diff: round2(r.value - p.value) }); }
  }
  for (const p of left.filter((x) => !x._m)) out.push({ status: 'falta_no_relatorio', date: p.date, description: p.description, pms: p.value, report: null });
  for (const r of right.filter((x) => !usedR.has(x._i))) out.push({ status: 'so_no_relatorio', date: r.date, description: r.description, pms: null, report: r.value });

  const sum = (st, f) => round2(out.filter((x) => x.status === st).reduce((s, x) => s + (x[f] || 0), 0));
  const count = (st) => out.filter((x) => x.status === st).length;
  return {
    summary: {
      ok: count('ok'), valor_diferente: count('valor_diferente'), falta_no_relatorio: count('falta_no_relatorio'), so_no_relatorio: count('so_no_relatorio'),
      total_pms: round2(pmsDebits.reduce((s, x) => s + x.value, 0)), total_relatorio: round2(reportRows.reduce((s, x) => s + x.value, 0)),
      valor_faltando: sum('falta_no_relatorio', 'pms'),
    },
    rows: out.sort((a, b) => a.date.localeCompare(b.date)),
  };
}
