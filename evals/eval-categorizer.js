#!/usr/bin/env node
/** Eval do categorizador: golden set escrito à mão + exigência de confiança coerente. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCategorizer } from '../src/lib/categorizer.js';
import { check, summarize, printReport, isMain } from './harness.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(DIR, 'fixtures/categorizer-cases.json'), 'utf-8'));

export function run(categorize = createCategorizer()) {
  const res = [];
  cases.forEach((c, i) => {
    const r = categorize(c.description);
    check(res, `C${String(i + 1).padStart(2, '0')} "${c.description}"`, r.category === c.expected, `esperado ${c.expected}, veio ${r.category}`);
  });
  // invariante: 'other' sempre com confiança baixa (vai para a fila de revisão)
  const others = cases.filter((c) => c.expected === 'other').map((c) => categorize(c.description));
  check(res, 'other ⇒ confiança low', others.every((r) => r.category !== 'other' || r.confidence === 'low'));
  return summarize('categorizador', res);
}

/** Implementações sabotadas que o eval TEM de reprovar (prova de que ele mede algo). */
export const sabotaged = {
  'sem normalizar acento': () => createCategorizer({ normalizeAccents: false }),
  'sem tratar "Pag. solicitado X"': () => createCategorizer({ stripPagPrefix: false }),
  'tudo vira other': () => () => ({ category: 'other', confidence: 'low' }),
};

if (isMain(import.meta.url)) process.exit(printReport(run()) ? 0 : 1);
