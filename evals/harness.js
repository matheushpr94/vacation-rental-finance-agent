/** Harness mínimo dos evals: cada eval exporta run(impl) → {name, passed, total, failures}. */
export function check(results, id, ok, detail = '') {
  results.push({ id, ok: !!ok, detail });
}

export function summarize(name, results) {
  const passed = results.filter((r) => r.ok).length;
  return { name, passed, total: results.length, failures: results.filter((r) => !r.ok) };
}

export function printReport(rep, { verbose = false, maxFailures = 8 } = {}) {
  const ok = rep.passed === rep.total;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${rep.name.padEnd(28)} ${rep.passed}/${rep.total}`);
  if (!ok || verbose) for (const f of rep.failures.slice(0, maxFailures)) console.log(`      ✗ ${f.id}${f.detail ? `: ${f.detail}` : ''}`);
  if (rep.failures.length > maxFailures) console.log(`      … e mais ${rep.failures.length - maxFailures}`);
  return ok;
}

export const isMain = (url) => url === `file://${process.argv[1]}`;
