/**
 * Anomalias por estatística robusta (mediana + MAD), sem LLM.
 *
 * Por que não z-score: com poucas amostras e distribuição assimétrica, média e desvio-padrão
 * são puxados pelo próprio outlier, e variações normais ("internet +2%") viravam alerta.
 *
 *  - categorias recorrentes: compara o TOTAL MENSAL com a mediana dos meses fechados (pega alta e queda)
 *  - demais categorias: compara cada lançamento com a mediana da categoria nos últimos 12 meses (n ≥ minN)
 *    e reporta só os lançamentos dos últimos `monthsBack` meses
 *  - pisos: além de K_MAD × MAD, o desvio precisa passar de FLOOR_ABS reais e de FLOOR_REL da mediana
 *  - queda a ~0 no último mês fechado não alerta (a conta pode só não ter sido lançada ainda)
 */
import { median, mad, monthKeyAgo, round2 } from './util.js';

export const DEFAULTS = { monthsBack: 6, txMonthsBack: 12, minN: 8, kMad: 3, floorAbs: 200, floorRel: 0.25 };
export const RECURRING = ['electricity', 'water', 'internet', 'gas', 'laundry', 'staff', 'pool'];

export function detectAnomalies(transactions, { asOf, ...cfg } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const from = `${monthKeyAgo(c.monthsBack, asOf)}-01`;
  const txFrom = `${monthKeyAgo(c.txMonthsBack, asOf)}-01`;
  const currentYm = asOf.slice(0, 7);
  const debits = transactions.filter((t) => t.type === 'debit' && t.date >= txFrom && t.date < asOf);
  const byCat = {};
  for (const t of debits) (byCat[t.category || 'other'] ||= []).push(t);

  const out = [];
  const pct = (dev, med) => (med ? Math.round((dev / med) * 100) : null);
  for (const [cat, txs] of Object.entries(byCat)) {
    if (RECURRING.includes(cat)) {
      const sums = {};
      for (let i = 1; i <= c.monthsBack; i++) sums[monthKeyAgo(i, asOf)] = 0; // só meses fechados
      for (const t of txs) { const k = t.date.slice(0, 7); if (k in sums && k !== currentYm) sums[k] += t.amount; }
      const entries = Object.entries(sums).sort();
      const vals = entries.map(([, v]) => v);
      if (vals.length < 4) continue;
      const med = median(vals);
      const m = mad(vals, med) || med * 0.1 || 1;
      const lastClosed = entries.at(-1)[0];
      for (const [k, v] of entries) {
        const dev = v - med;
        if (dev < 0 && v < med * 0.05 && k === lastClosed) continue;
        if (Math.abs(dev) > c.kMad * m && Math.abs(dev) > c.floorAbs && Math.abs(dev) > med * c.floorRel) {
          out.push({ kind: 'monthly', category: cat, month: k, value: round2(v), median: round2(med), deviation_pct: pct(dev, med), direction: dev > 0 ? 'alta' : 'queda' });
        }
      }
    } else {
      if (txs.length < c.minN) continue;
      const vals = txs.map((t) => t.amount);
      const med = median(vals);
      const m = mad(vals, med) || med * 0.2 || 1;
      for (const t of txs) {
        if (t.date < from) continue;
        const dev = t.amount - med;
        if (dev > c.kMad * m && dev > c.floorAbs && t.amount > med * (1 + c.floorRel)) {
          out.push({ kind: 'transaction', category: cat, id: t.id, date: t.date, description: t.description, value: t.amount, median: round2(med), deviation_pct: pct(dev, med) });
        }
      }
    }
  }
  return out.sort((a, b) => (a.month || a.date).localeCompare(b.month || b.date));
}
