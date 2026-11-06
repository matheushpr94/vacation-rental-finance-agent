/**
 * Deduplicação de reservas em cascata (3 critérios).
 *
 * Motivação: a PMS da gestora troca o identificador da reserva depois do checkout. Um sync que
 * confia só no id externo insere a mesma estadia de novo a cada execução. Por isso:
 *
 *   1. mesmo external_id                                   → duplicata
 *   2. mesmo check_in + check_out + nome parecido          → duplicata (pega o id trocado)
 *   3. mesmo check_out + valor líquido ±10% + nome parecido → duplicata (pega id trocado + data de
 *      entrada ajustada)
 *   (4) mesmas datas mas nome/valor diferentes             → não é duplicata, mas sinaliza UPDATE
 *
 * Reservas canceladas nunca contam como existentes.
 * Todas as funções são puras: recebem a lista de reservas existentes em vez de consultar um banco.
 */
import { removeAccents } from './categorizer.js';

const PREPOSITIONS = /\b(de|da|do|das|dos|e)\b/g;

export function normalizeName(name, { dropPrepositions = true } = {}) {
  if (!name) return '';
  let s = removeAccents(String(name).toLowerCase());
  if (dropPrepositions) s = s.replace(PREPOSITIONS, ' ');
  return s.replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isPlaceholderName(name) {
  if (name == null) return true;
  const s = String(name).toLowerCase().trim();
  return ['', '-', 'guest name', 'unknown', 'hospede', 'hóspede', 'sem nome'].includes(s);
}

export function namesMatch(a, b, opts = {}) {
  if (isPlaceholderName(a) || isPlaceholderName(b)) return false;
  const n1 = normalizeName(a, opts);
  const n2 = normalizeName(b, opts);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;
  // um contém o outro como sequência de palavras inteiras ("heloa albuquerque" não está contido em "heloa clotilde albuquerque";
  // "heloa" em "heloa albuquerque" sim)
  const w1 = ` ${n1} `, w2 = ` ${n2} `;
  if (w1.includes(w2) || w2.includes(w1)) return true;
  const p1 = n1.split(' '), p2 = n2.split(' ');
  if (p1.length >= 2 && p2.length >= 2 && p1[0] === p2[0] && p1.at(-1) === p2.at(-1)) return true;
  return false;
}

export function valuesMatch(v1, v2, marginPct = 10) {
  const a = Number(v1), b = Number(v2);
  if (!a || !b || Number.isNaN(a) || Number.isNaN(b)) return false;
  return (Math.abs(a - b) / ((a + b) / 2)) * 100 <= marginPct;
}

/**
 * @param {Array} existing  reservas já gravadas
 * @param {object} incoming { external_id, check_in, check_out, guest_name, net_value }
 * @param {object} opts     `criteria` permite desligar critérios (usado pelo selftest dos evals)
 * @returns {{duplicate:boolean, criterion:number|null, match:object|null, should_update?:boolean, reason:string|null}}
 */
export function findDuplicate(existing, incoming, opts = {}) {
  const criteria = opts.criteria || [1, 2, 3, 4];
  const nm = (a, b) => namesMatch(a, b, opts);
  const live = existing.filter((r) => r.status !== 'cancelled');
  const { external_id, check_in, check_out, guest_name, net_value } = incoming;

  if (criteria.includes(1) && external_id) {
    const m = live.find((r) => r.external_id === external_id);
    if (m) return { duplicate: true, criterion: 1, match: m, reason: `external_id igual (${external_id})` };
  }
  if (criteria.includes(2) && check_in && check_out && guest_name) {
    const m = live.find((r) => r.check_in === check_in && r.check_out === check_out && nm(r.guest_name, guest_name));
    if (m) return { duplicate: true, criterion: 2, match: m, reason: `mesmas datas ${check_in}→${check_out} e nome compatível` };
  }
  if (criteria.includes(3) && check_out && net_value && guest_name) {
    const m = live.find((r) => r.check_out === check_out && valuesMatch(r.net_value, net_value) && nm(r.guest_name, guest_name));
    if (m) return { duplicate: true, criterion: 3, match: m, reason: `mesmo checkout ${check_out}, valor ±10% e nome compatível` };
  }
  if (criteria.includes(4) && check_in && check_out) {
    const m = live.find((r) => r.check_in === check_in && r.check_out === check_out);
    if (m) return { duplicate: false, criterion: 4, match: m, should_update: true, reason: 'mesmas datas com nome/valor diferentes: atualizar, não inserir' };
  }
  return { duplicate: false, criterion: null, match: null, reason: null };
}

/** id determinístico de transação: data + descrição normalizada + valor. */
export function transactionExternalId({ date, description, amount, type }) {
  const d = removeAccents(String(description).toLowerCase()).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  return `pms_${type}_${date}_${d}_${Number(amount).toFixed(2)}`;
}
