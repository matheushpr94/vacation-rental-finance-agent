#!/usr/bin/env node
/**
 * Eval do dedup. Duas camadas:
 *   A) funções puras (namesMatch, valuesMatch, isPlaceholderName): casos escritos à mão
 *   B) cascata findDuplicate: cenários com reservas existentes × reserva chegando, incluindo os
 *      casos que motivaram o código (id trocado após checkout, nome com/sem acento e preposição)
 *   C) ponta a ponta: replay do sync na PMS fake → nenhuma estadia duplicada no banco
 */
import { namesMatch, valuesMatch, isPlaceholderName, findDuplicate } from '../src/lib/dedup.js';
import { replay } from '../src/sync.js';
import { emptyStore } from '../src/lib/store.js';
import { check, summarize, printReport, isMain } from './harness.js';

const NAMES = [
  ['Heloá de Albuquerque Siqueira', 'Heloá de Albuquerque Siqueira', true, 'idêntico'],
  ['Jurandir Pacheco', 'jurandir pacheco', true, 'caixa'],
  ['Heloá de Albuquerque Siqueira', 'Heloa Albuquerque Siqueira', true, 'acento + preposição'],
  ['Quitéria das Neves Barreto', 'Quiteria Neves Barreto', true, '"das" + acento'],
  ['Petrônio dos Anjos Uchôa', 'Petronio Uchoa', true, 'primeiro + último, sem acento'],
  ['Isaura Magalhães', 'Isaura Clotilde Magalhães', true, 'nome do meio a mais'],
  ['Odete Falcão', 'Odete', true, 'só o primeiro nome (contido)'],
  ['Xisto Lacerda', 'Xisto Lacerda Filho', true, 'sufixo'],
  ['Laudelino Brandão', 'Laudelino Coutinho', false, 'mesmo primeiro nome, sobrenome diferente'],
  ['Mirtes Ornelas', 'Palmira Ornelas', false, 'mesmo sobrenome, pessoas diferentes'],
  ['Olga Lacerda', 'Olgarina Lacerda', false, 'prefixo de palavra não conta'],
  ['Rosalvo Tavares', 'Guest Name', false, 'placeholder nunca casa'],
  ['', 'Rosalvo Tavares', false, 'vazio'],
  [null, 'Rosalvo Tavares', false, 'nulo'],
  ['Dalva e Sobral Coutinho', 'Dalva Coutinho', true, '"e" tratado como conectivo'],
  ['Isaura da Silveira', 'Isaura Silveira Lemos', true, 'preposição impede o "contido" sem normalizar'],
  ['Genésio do Amaral', 'Genesio Amaral Neto', true, 'idem, com acento'],
];
const VALUES = [
  [8500, 8500, true], [8500, 9100, true], [8500, 9500, false], [10000, 10950, true], [10000, 11100, false],
  [null, 8500, false], [0, 0, false], [5000, 'abc', false],
];
const PLACEHOLDERS = [['Guest Name', true], ['unknown', true], ['-', true], ['', true], [null, true], ['Hóspede', true], ['Zenaide Holanda', false]];

const base = [
  { id: 'r1', external_id: 'pms_a1', guest_name: 'Heloá de Albuquerque Siqueira', check_in: '2026-09-04', check_out: '2026-09-09', net_value: 9180, status: 'completed' },
  { id: 'r2', external_id: 'pms_b2', guest_name: 'Petrônio dos Anjos Uchôa', check_in: '2026-09-13', check_out: '2026-09-18', net_value: 9741, status: 'completed' },
  { id: 'r3', external_id: 'pms_c3', guest_name: 'Tibério Tavares', check_in: '2026-10-01', check_out: '2026-10-05', net_value: 6120, status: 'completed' },
  { id: 'r4', external_id: 'pms_d4', guest_name: 'Valquíria Rebouças', check_in: '2026-06-10', check_out: '2026-06-14', net_value: 5100, status: 'cancelled' },
  { id: 'r5', external_id: 'pms_e5', guest_name: 'Norberto Leitão', check_in: '2026-12-20', check_out: '2026-12-27', net_value: 18700, status: 'confirmed' },
];
const SCENARIOS = [
  { id: 'S01 mesmo id', in: { external_id: 'pms_a1', guest_name: 'x', check_in: '2026-09-04', check_out: '2026-09-09', net_value: 9180 }, dup: true, crit: 1 },
  { id: 'S02 id trocado pós-checkout, nome sem acento/preposição', in: { external_id: 'pms_a1_v2', guest_name: 'Heloa Albuquerque Siqueira', check_in: '2026-09-04', check_out: '2026-09-09', net_value: 9180 }, dup: true, crit: 2 },
  { id: 'S03 id trocado + check-in corrigido + valor +4%', in: { external_id: 'pms_b2_v2', guest_name: 'Petronio Uchoa', check_in: '2026-09-14', check_out: '2026-09-18', net_value: 10130.64 }, dup: true, crit: 3 },
  { id: 'S04 id trocado + valor +15% (fora da margem)', in: { external_id: 'pms_b2_v3', guest_name: 'Petronio Uchoa', check_in: '2026-09-14', check_out: '2026-09-18', net_value: 11200 }, dup: false, crit: null },
  { id: 'S05 id trocado + nome virou placeholder → UPDATE', in: { external_id: 'pms_c3_v2', guest_name: 'Guest Name', check_in: '2026-10-01', check_out: '2026-10-05', net_value: 6120 }, dup: false, crit: 4, update: true },
  { id: 'S06 mesmas datas, outra pessoa → UPDATE (não insere 2ª reserva nas mesmas datas)', in: { external_id: 'pms_z9', guest_name: 'Yolanda Esteves', check_in: '2026-10-01', check_out: '2026-10-05', net_value: 6500 }, dup: false, crit: 4, update: true },
  { id: 'S07 reserva cancelada não conta', in: { external_id: 'pms_d4_v2', guest_name: 'Valquiria Reboucas', check_in: '2026-06-10', check_out: '2026-06-14', net_value: 5100 }, dup: false, crit: null },
  { id: 'S08 mesmo id de reserva cancelada não conta', in: { external_id: 'pms_d4', guest_name: 'Valquíria Rebouças', check_in: '2026-06-10', check_out: '2026-06-14', net_value: 5100 }, dup: false, crit: null },
  { id: 'S09 reserva nova legítima', in: { external_id: 'pms_new', guest_name: 'Cremilda Gusmão', check_in: '2027-01-08', check_out: '2027-01-12', net_value: 9900 }, dup: false, crit: null },
  { id: 'S10 mesmo checkout, valor parecido, pessoa diferente', in: { external_id: 'pms_new2', guest_name: 'Belmiro Aragão', check_in: '2026-12-21', check_out: '2026-12-27', net_value: 18500 }, dup: false, crit: null },
  { id: 'S11 só primeiro nome + id novo + mesmas datas', in: { external_id: 'pms_e5_v2', guest_name: 'Norberto', check_in: '2026-12-20', check_out: '2026-12-27', net_value: 18700 }, dup: true, crit: 2 },
];

export function run(impl = { namesMatch, valuesMatch, isPlaceholderName, findDuplicate }, { e2e = true } = {}) {
  const res = [];
  NAMES.forEach(([a, b, exp, note], i) => check(res, `N${String(i + 1).padStart(2, '0')} ${note}`, impl.namesMatch(a, b) === exp, `"${a}" × "${b}" esperado ${exp}`));
  VALUES.forEach(([a, b, exp], i) => check(res, `V${i + 1} ${a}×${b}`, impl.valuesMatch(a, b) === exp, `esperado ${exp}`));
  PLACEHOLDERS.forEach(([a, exp], i) => check(res, `P${i + 1} "${a}"`, impl.isPlaceholderName(a) === exp, `esperado ${exp}`));
  for (const s of SCENARIOS) {
    const r = impl.findDuplicate(base, s.in);
    const ok = r.duplicate === s.dup && (s.crit === null ? r.criterion === null : r.criterion === s.crit) && (!s.update || r.should_update === true);
    check(res, s.id, ok, `veio duplicate=${r.duplicate} criterio=${r.criterion}`);
  }
  return summarize('dedup', res);
}

/** Camada C: replay completo do sync na PMS fake. Retorna checks extras. */
export async function runEndToEnd(findDup = findDuplicate) {
  const res = [];
  const { store, stats } = await replay({ store: emptyStore(), findDuplicate: findDup });
  const byCode = {};
  for (const r of store.reservations) byCode[r.code] = (byCode[r.code] || 0) + 1;
  const dups = Object.entries(byCode).filter(([, n]) => n > 1);
  check(res, 'E2E nenhuma estadia duplicada após replay', dups.length === 0, `${dups.length} códigos duplicados: ${dups.map(([c, n]) => `${c}×${n}`).join(', ')}`);
  check(res, 'E2E os 3 ids trocados viraram alias', store.reservations.filter((r) => r.aliases?.length).length === 3);
  check(res, 'E2E divergência de valor sinalizada, não sobrescrita', stats.value_divergences === 1);
  const tx = new Set(store.transactions.map((t) => t.external_id));
  check(res, 'E2E nenhum lançamento duplicado', tx.size === store.transactions.length);
  return summarize('dedup ponta a ponta (sync)', res);
}

export const sabotaged = {
  'só critério 1 (id externo)': { findDuplicate: (e, i) => findDuplicate(e, i, { criteria: [1] }) },
  'sem remover preposições': { namesMatch: (a, b) => namesMatch(a, b, { dropPrepositions: false }), findDuplicate: (e, i) => findDuplicate(e, i, { dropPrepositions: false }) },
  'margem de valor 20%': { valuesMatch: (a, b) => valuesMatch(a, b, 20) },
};

if (isMain(import.meta.url)) {
  const a = printReport(run());
  const b = printReport(await runEndToEnd());
  process.exit(a && b ? 0 : 1);
}
