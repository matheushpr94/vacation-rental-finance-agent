#!/usr/bin/env node
/**
 * Eval do parser LLM de parcelas.
 *
 *   A) validador isolado: saídas boas e ruins conhecidas
 *   B) parseObservation com respostas simuladas do modelo (offline, determinístico): checa fonte
 *      (llm/fallback), nº de tentativas, nº de chamadas, valores e vencimentos
 *   C) invariantes em TODA saída: soma = líquido ±1, 1ª parcela paga, ≤ 12 parcelas
 *
 *   --live  manda as mesmas observações para a API (precisa de ANTHROPIC_API_KEY) e checa
 *           só os valores/datas esperados e as invariantes. Sem chave, é pulado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseObservation, validateInstallments, MAX_INSTALLMENTS } from '../src/lib/parse-observation.js';
import { createAnthropicLLM } from '../src/lib/llm.js';
import { check, summarize, printReport, isMain } from './harness.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(DIR, 'fixtures/parser-cases.json'), 'utf-8'));

const ok2 = [{ installment_number: 1, amount: 500, paid: true, due_date: null }, { installment_number: 2, amount: 500, paid: false, due_date: '2026-12-01' }];
const VALIDATOR = [
  ['válido', ok2, true],
  ['soma errada', [{ ...ok2[0] }, { ...ok2[1], amount: 400 }], false],
  ['soma dentro de ±1', [{ ...ok2[0] }, { ...ok2[1], amount: 500.9 }], true],
  ['1ª não paga', [{ ...ok2[0], paid: false }, ok2[1]], false],
  ['vencimento após check-in', [ok2[0], { ...ok2[1], due_date: '2027-01-02' }], false],
  ['data inexistente', [ok2[0], { ...ok2[1], due_date: '2026-02-30' }], false],
  ['numeração fora de ordem', [ok2[0], { ...ok2[1], installment_number: 3 }], false],
  ['valor negativo compensado', [{ ...ok2[0], amount: 1200 }, { ...ok2[1], amount: -200 }], false],
  ['amount como string', [{ ...ok2[0], amount: '500' }, ok2[1]], false],
  ['array vazio', [], false],
  ['não é array', { amount: 1000 }, false],
];

function mockLLM(responses, c) {
  let i = 0;
  const fn = async () => {
    fn.calls++;
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === '__THROW__') throw new Error('timeout simulado');
    if (r === '__13X__') {
      const v = Math.round((c.net_value / 13) * 100) / 100;
      return JSON.stringify(Array.from({ length: 13 }, (_, k) => ({ installment_number: k + 1, amount: k === 12 ? Math.round((c.net_value - v * 12) * 100) / 100 : v, paid: k === 0, due_date: null, notes: `${k + 1}/13` })));
    }
    return r;
  };
  fn.calls = 0;
  return fn;
}

function invariants(res, id, out, c) {
  const sum = out.reduce((s, p) => s + Number(p.amount), 0);
  check(res, `${id} inv: soma = líquido`, Math.abs(sum - c.net_value) <= 1, `soma ${sum} vs ${c.net_value}`);
  check(res, `${id} inv: 1ª paga e ≤${MAX_INSTALLMENTS}`, out[0]?.paid === true && out.length <= MAX_INSTALLMENTS);
}

export async function run(parse = parseObservation, { attempts = 2, validate = true } = {}) {
  const res = [];
  VALIDATOR.forEach(([label, list, exp], i) => {
    const errs = validateInstallments(list, { net_value: 1000, check_in: '2026-12-31' });
    check(res, `V${String(i + 1).padStart(2, '0')} validador: ${label}`, (errs.length === 0) === exp, errs.join('; '));
  });
  for (const c of cases) {
    const llm = c.responses ? mockLLM(c.responses, c) : null;
    const r = await parse({ observation: c.observation, net_value: c.net_value, check_in: c.check_in }, { llm, attempts, validate });
    const out = r.installments;
    const e = c.expect;
    check(res, `${c.id} ${c.label}: fonte/tentativas`, r.source === e.source && r.attempts === e.attempts, `veio ${r.source}/${r.attempts}, esperado ${e.source}/${e.attempts}`);
    if (e.llm_calls !== undefined) check(res, `${c.id} chamadas ao modelo`, (llm?.calls ?? 0) === e.llm_calls, `veio ${llm?.calls ?? 0}`);
    check(res, `${c.id} valores`, JSON.stringify(out.map((p) => Number(p.amount))) === JSON.stringify(e.amounts), `veio ${JSON.stringify(out.map((p) => p.amount))}`);
    check(res, `${c.id} vencimentos`, JSON.stringify(out.map((p) => p.due_date ?? null)) === JSON.stringify(e.due_dates), `veio ${JSON.stringify(out.map((p) => p.due_date))}`);
    invariants(res, c.id, out, c);
  }
  return summarize('parser de parcelas (mock)', res);
}

export async function runLive() {
  const llm = await createAnthropicLLM();
  if (!llm) return null;
  const res = [];
  for (const c of cases.filter((x) => x.expect.source === 'llm' || x.id === 'P09')) {
    const r = await parseObservation({ observation: c.observation, net_value: c.net_value, check_in: c.check_in }, { llm });
    const out = r.installments;
    if (c.id === 'P09') {
      check(res, `${c.id} injection não vira parcela de R$ 1`, !out.some((p) => Number(p.amount) === 1));
    } else {
      check(res, `${c.id} valores`, JSON.stringify(out.map((p) => Number(p.amount))) === JSON.stringify(c.expect.amounts), JSON.stringify(out.map((p) => p.amount)));
      check(res, `${c.id} vencimentos`, JSON.stringify(out.map((p) => p.due_date ?? null)) === JSON.stringify(c.expect.due_dates), JSON.stringify(out.map((p) => p.due_date)));
    }
    invariants(res, c.id, out, c);
  }
  return summarize('parser de parcelas (API real)', res);
}

export const sabotaged = {
  'sem validação da saída do LLM': { validate: false },
  'sem retry (1 tentativa)': { attempts: 1 },
};

if (isMain(import.meta.url)) {
  let ok = printReport(await run());
  if (process.argv.includes('--live')) {
    const live = await runLive();
    if (live) ok = printReport(live) && ok; else console.log('SKIP  parser (API real): ANTHROPIC_API_KEY ausente');
  }
  process.exit(ok ? 0 : 1);
}
