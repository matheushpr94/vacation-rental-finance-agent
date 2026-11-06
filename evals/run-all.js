#!/usr/bin/env node
/**
 * Roda todos os evals offline e imprime o placar.
 *   --selftest  roda os evals contra implementações SABOTADAS e exige que cada uma reprove.
 *               Se um eval aprova uma implementação quebrada, ele não está medindo nada.
 *   --json      grava evals/results.json
 *   --live      inclui o parser contra a API real (precisa de ANTHROPIC_API_KEY)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cat from './eval-categorizer.js';
import * as ded from './eval-dedup.js';
import * as par from './eval-parser.js';
import * as fin from './eval-finance.js';
import * as dedupLib from '../src/lib/dedup.js';
import { parseObservation } from '../src/lib/parse-observation.js';
import { printReport } from './harness.js';

const args = new Set(process.argv.slice(2));
const DIR = path.dirname(fileURLToPath(import.meta.url));

async function normal() {
  const reps = [cat.run(), ded.run(), await ded.runEndToEnd(), await par.run(), await fin.run()];
  if (args.has('--live')) { const l = await par.runLive(); if (l) reps.push(l); else console.log('SKIP  parser (API real): sem ANTHROPIC_API_KEY'); }
  let ok = true;
  for (const r of reps) ok = printReport(r) && ok;
  const passed = reps.reduce((s, r) => s + r.passed, 0), total = reps.reduce((s, r) => s + r.total, 0);
  console.log(`\nTOTAL ${passed}/${total} ${ok ? '— tudo verde' : '— HÁ FALHAS'}`);
  if (args.has('--json')) fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(reps.map(({ name, passed, total }) => ({ name, passed, total })), null, 2) + '\n');
  return ok;
}

async function selftest() {
  const rows = [];
  for (const [k, mk] of Object.entries(cat.sabotaged)) rows.push(['categorizador', k, cat.run(mk())]);
  for (const [k, o] of Object.entries(ded.sabotaged)) {
    const unit = ded.run({ ...dedupLib, ...o });
    const e2e = o.findDuplicate ? await ded.runEndToEnd(o.findDuplicate) : { passed: 0, total: 0 };
    rows.push(['dedup', k, { passed: unit.passed + e2e.passed, total: unit.total + e2e.total }]);
  }
  for (const [k, o] of Object.entries(par.sabotaged)) rows.push(['parser', k, await par.run(parseObservation, { attempts: 2, validate: true, ...o })]);
  for (const [k, o] of Object.entries(fin.sabotaged)) rows.push(['saldos', k, await fin.run(o)]);
  let ok = true;
  console.log('SELFTEST: cada implementação sabotada TEM de reprovar\n');
  for (const [ev, k, r] of rows) {
    const caught = r.passed < r.total;
    ok &&= caught;
    console.log(`${caught ? 'OK   reprovou' : 'ERRO aprovou '}  ${ev.padEnd(14)} ${k.padEnd(36)} ${r.passed}/${r.total}`);
  }
  console.log(`\n${ok ? 'SELFTEST OK: os evals detectam todas as sabotagens' : 'SELFTEST FALHOU: algum eval aprovou código quebrado'}`);
  return ok;
}

process.exit((args.has('--selftest') ? await selftest() : await normal()) ? 0 : 1);
