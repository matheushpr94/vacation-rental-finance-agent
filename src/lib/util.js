/** Utilitários pequenos e sem dependência: datas em UTC (YYYY-MM-DD), dinheiro e PRNG com semente. */

export const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (isoDate, n) => { const d = toDate(isoDate); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const ym = (isoDate) => isoDate.slice(0, 7);
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86_400_000);

/** chave YYYY-MM de `i` meses antes de `base` (sem overflow de fim de mês). */
export function monthKeyAgo(i, base) {
  const d = toDate(base);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - i);
  return iso(d).slice(0, 7);
}
export function addMonths(ymKey, n) {
  const d = toDate(`${ymKey}-01`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d).slice(0, 7);
}
export function lastDayOfMonth(ymKey) {
  const d = toDate(`${addMonths(ymKey, 1)}-01`);
  d.setUTCDate(0);
  return iso(d);
}

export const round2 = (x) => Math.round(x * 100) / 100;
export const brl = (v) => `${v < 0 ? '-' : ''}R$ ${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** MAD escalado (≈ desvio-padrão para dados normais). */
export const mad = (a, med = median(a)) => 1.4826 * median(a.map((x) => Math.abs(x - med)));

/** PRNG determinístico (mulberry32). */
export function rng(seed) {
  let t = seed >>> 0;
  const next = () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    float: (lo, hi) => lo + next() * (hi - lo),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}
